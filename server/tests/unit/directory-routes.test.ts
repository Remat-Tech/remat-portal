import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Express, type Response, type Router } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Application, buildApp } from '../../src/app.js';
import type { AdministrationService } from '../../src/apps/directory/administration.service.js';
import type { DirectoryEmailService } from '../../src/apps/directory/email.service.js';
import { MAX_PHOTO_BYTES, PhotoNotFound } from '../../src/apps/directory/photo.js';
import type { PhotoService } from '../../src/apps/directory/photo.service.js';
import {
  DIRECTORY_LIMITS,
  type DirectoryLimits,
  directoryRoutes,
} from '../../src/apps/directory/routes.js';
import type { DirectoryService } from '../../src/apps/directory/directory.service.js';
import { signedInAs } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import { answerProblems } from '../../src/core/http/problems.js';
import { rateLimit, TooManyRequests } from '../../src/core/http/rate-limit.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * The directory's routes, with nothing behind them.
 *
 * Who may do what is the policy's, tested in directory.test.ts, and what each route answers is
 * directory-api.test.ts's. This is the two things that belong to the mounting: nothing answers
 * without a session, and the limits sit in front of the routes they are for.
 */

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const denials = recordingDenials();
const guard = new Guard(denials);

/** Everything behind the routes, answering as simply as it can. */
const everyService = {
  directory: {
    read: () =>
      Promise.resolve({
        today: '2026-10-30',
        people: [],
        departments: [],
        may: { administer: false, seeLoginsToCreate: false },
      }),
    chart: () => Promise.resolve({ today: '2026-10-30', lines: [], total: 0 }),
    person: () => Promise.reject(new PhotoNotFound()),
  } as unknown as DirectoryService,
  photos: {
    upload: () => Promise.reject(new PhotoNotFound()),
    read: () => Promise.reject(new PhotoNotFound()),
  } as unknown as PhotoService,
  emails: {} as DirectoryEmailService,
  administration: {
    list: () => Promise.reject(new PhotoNotFound()),
  } as unknown as AdministrationService,
};

function listening(app: Express): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;

      resolve({ server, origin: `http://127.0.0.1:${String(port)}` });
    });
  });
}

function closed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** Every method and path a router answers, read off the router rather than written out. */
function routesOf(router: Router): [string, string][] {
  return router.stack.flatMap((layer) =>
    layer.route === undefined || layer.route === null
      ? []
      : Object.keys((layer.route as unknown as { methods: Record<string, boolean> }).methods).map(
          (method): [string, string] => [
            method.toUpperCase(),
            String(layer.route?.path).replace(/:[A-Za-z]+/g, '1'),
          ],
        ),
  );
}

describe('every route', () => {
  let server: Server;
  let origin: string;

  /* Nothing here is reached: signed out, identify answers before anything is read. */
  beforeAll(async () => {
    ({ server, origin } = await listening(
      buildApp({
        guard,
        secret: SECRET,
        photos: {},
        patterns: {},
        employeeRecords: {},
        directoryEmails: {},
      } as unknown as Application),
    ));
  });

  afterAll(() => closed(server));

  const routes = routesOf(directoryRoutes({ guard, ...everyService }));

  it('is found, so the check below is about something', () => {
    expect(routes).toContainEqual(['GET', '/directory']);
    expect(routes).toContainEqual(['PUT', '/people/1/photo']);
    expect(routes).toContainEqual(['GET', '/directory/admin/people']);
    expect(routes.length).toBeGreaterThan(15);
  });

  it.each(routes)('%s %s needs a session', async (method, path) => {
    expect((await fetch(`${origin}/api${path}`, { method })).status).toBe(401);
  });
});

describe('the limits', () => {
  const tight: DirectoryLimits = {
    lookups: { max: 2, windowSeconds: 60 },
    photoUploads: { max: 1, windowSeconds: 3600 },
  };

  let server: Server;
  let origin: string;

  beforeEach(async () => {
    denials.clear();

    const app = express();

    app.use((request, response, next) => {
      response.locals.actor = signedInAs(request.get('x-who') ?? 'adwoa', {
        roles: ['EMPLOYEE'],
        isManager: false,
      });
      next();
    });
    app.use('/api', directoryRoutes({ guard, ...everyService, limits: tight }));
    app.use(answerProblems({ record: () => undefined }));

    ({ server, origin } = await listening(app));
  });

  afterEach(() => closed(server));

  const get = (path: string, who = 'adwoa') =>
    fetch(`${origin}/api${path}`, { headers: { 'x-who': who } });

  const upload = (bytes: number) =>
    fetch(`${origin}/api/people/adwoa/photo`, {
      method: 'PUT',
      headers: { 'x-who': 'adwoa', 'content-type': 'image/webp' },
      body: new Uint8Array(bytes),
    });

  it('refuses the lookup past the limit with a 429 that says to wait, and when', async () => {
    await get('/directory');
    await get('/directory');

    const refused = await get('/directory');

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({
      error: 'TooManyRequests',
      message: expect.stringContaining('Wait') as unknown,
    });
  });

  it('counts the list and one person’s profile together', async () => {
    await get('/directory');
    await get('/directory/people/1');

    expect((await get('/directory/people/2')).status).toBe(429);
  });

  it('counts HR’s list with them', async () => {
    await get('/directory');
    await get('/directory');

    expect((await get('/directory/admin/people')).status).toBe(429);
  });

  it('counts each person apart', async () => {
    await get('/directory');
    await get('/directory');

    expect((await get('/directory', 'kofi')).status).toBe(200);
  });

  it('writes a refused lookup to the denial log, naming nobody looked up', async () => {
    await get('/directory');
    await get('/directory');
    await get('/directory/people/4471');

    expect(denials.entries).toHaveLength(1);
    expect(denials.last()).toMatchObject({
      employeeId: 'adwoa',
      resource: 'rate limit',
      action: 'lookUpPeople',
      subject: null,
      because: 'more than 2 in 60 seconds',
    });
  });

  it('leaves the chart and reading a photo alone', async () => {
    const answers = await Promise.all(
      [1, 2, 3, 4, 5].flatMap(() => [get('/directory/chart'), get('/photos/1/thumbnail')]),
    );

    expect(answers.map((one) => one.status)).not.toContain(429);
  });

  it('refuses an upload past the limit before reading it', async () => {
    await upload(1);

    /* Over the size cap, so a 429 rather than a 413 shows the limit answered first. */
    const refused = await upload(MAX_PHOTO_BYTES + 1);

    expect(refused.status).toBe(429);
    expect(denials.last()).toMatchObject({ action: 'uploadPhoto' });
  });

  it('holds uploads and lookups to separate counts', async () => {
    await upload(1);

    expect((await get('/directory')).status).toBe(200);
  });

  it('ships with room for somebody working normally', () => {
    expect(DIRECTORY_LIMITS.lookups.max).toBeGreaterThanOrEqual(60);
    expect(DIRECTORY_LIMITS.photoUploads.max).toBeGreaterThanOrEqual(10);
  });
});

describe('a window', () => {
  const actor = signedInAs('adwoa', { roles: ['EMPLOYEE'], isManager: false });

  function knocking() {
    const clock = { now: 0 };
    const handler = rateLimit(
      new Guard(recordingDenials()),
      'testing',
      { max: 1, windowSeconds: 60 },
      'Wait.',
      () => clock.now,
    );

    const knock = () => {
      let answer: unknown = 'not called';
      const headers: Record<string, string> = {};

      void handler(
        {} as never,
        {
          locals: { actor },
          set(name: string, value: string) {
            headers[name] = value;
          },
        } as unknown as Response,
        (error?: unknown) => {
          answer = error;
        },
      );

      return { answer, headers };
    };

    return { clock, knock };
  }

  it('opens again the moment it ends, and not before', () => {
    const { clock, knock } = knocking();

    expect(knock().answer).toBeUndefined();

    clock.now = 59_999;
    expect(knock().answer).toBeInstanceOf(TooManyRequests);

    clock.now = 60_000;
    expect(knock().answer).toBeUndefined();
  });

  it('says how many seconds are left, rounded up', () => {
    const { clock, knock } = knocking();

    knock();
    clock.now = 58_500;

    const { answer, headers } = knock();

    expect((answer as TooManyRequests).retryAfterSeconds).toBe(2);
    expect(headers['Retry-After']).toBe('2');
  });
});
