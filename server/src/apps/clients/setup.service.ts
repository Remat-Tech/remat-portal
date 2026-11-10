/**
 * Products and lines, kept by a BD manager. #293, Clients SRS CLI 07, CLI 08, TDD 3.
 *
 * Every method asks `clientsPolicy.setUp` first, before reading the request or looking anything
 * up, so somebody refused learns nothing from what they sent. Checklists and reasons join this
 * service when they are built.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import { clientsPolicy } from './policy.js';
import {
  ClientsLineNotFound,
  ClientsLineRetired,
  ClientsProductNotFound,
  isAnId,
  type Product,
  type ProductLine,
  readLineId,
  readName,
} from './product.js';
import type { ClientsProductRepository } from './product.db.js';
import type { ClientsRoleRepository } from './role.db.js';

export class SetupService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly products: ClientsProductRepository,
  ) {}

  /** Every line and its products, retired ones included and marked. */
  async lines(actor: Actor): Promise<ProductLine[]> {
    await this.mustSetUp(actor);

    return this.products.lines();
  }

  async addLine(actor: Actor, body: unknown): Promise<ProductLine> {
    await this.mustSetUp(actor);

    return this.products.addLine(actor, readName(body, 'line'));
  }

  /** Adds a product to a line that is taking deals. */
  async addProduct(actor: Actor, body: unknown): Promise<Product> {
    await this.mustSetUp(actor);

    const name = readName(body, 'product');
    const line = await this.lineOrRefuse(readLineId(body));

    if (line.retiredOn !== null) {
      throw new ClientsLineRetired(line.name, 'add');
    }

    return this.products.addProduct(actor, line.id, name);
  }

  async renameLine(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const name = readName(body, 'line');
    await this.lineOrRefuse(id);
    await this.products.renameLine(actor, id, name);
  }

  async renameProduct(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const name = readName(body, 'product');
    await this.productOrRefuse(id);
    await this.products.renameProduct(actor, id, name);
  }

  /** Retires a line, and every product in it, today. */
  async retireLine(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.lineOrRefuse(id);

    await this.products.retireLine(actor, id, currentDate());
  }

  async retireProduct(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.productOrRefuse(id);

    await this.products.retireProduct(actor, id, currentDate());
  }

  /** Brings a line back to taking deals. Its products are restored one by one. */
  async restoreLine(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.lineOrRefuse(id);

    await this.products.restoreLine(actor, id);
  }

  /** Brings a product back, into a line that is itself taking deals. */
  async restoreProduct(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);

    const product = await this.productOrRefuse(id);
    const line = await this.lineOrRefuse(product.lineId);

    if (line.retiredOn !== null) {
      throw new ClientsLineRetired(line.name, 'restore');
    }

    await this.products.restoreProduct(actor, id);
  }

  private async mustSetUp(actor: Actor): Promise<void> {
    this.guard.enforce(clientsPolicy.setUp(actor, await accessOf(actor, this.grants)));
  }

  private async lineOrRefuse(id: string): Promise<ProductLine> {
    const line = isAnId(id) ? await this.products.findLine(id) : undefined;

    if (line === undefined) {
      throw new ClientsLineNotFound();
    }

    return line;
  }

  private async productOrRefuse(id: string): Promise<Product> {
    const product = isAnId(id) ? await this.products.findProduct(id) : undefined;

    if (product === undefined) {
      throw new ClientsProductNotFound();
    }

    return product;
  }
}
