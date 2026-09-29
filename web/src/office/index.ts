// Entry point of the office renderer: picks the view for the art that is
// available and wires it to the model.
//   mega view   LimeZu "Modern Office" (loaded at runtime from /packs, never bundled) + CC0 people
//   tower view  CC0 art only; used silently when the pack is missing or `?pack=none`
import { loadAll } from './sprites';
import { loadPack } from './packs/limezu';
import { createMegaView } from './mega';
import { createTowerView } from './tower';
import type { OfficeModel } from './model';
import type { Host, OfficeView } from './types';

export interface Office {
  view: OfficeView;
  /** Art credits to show in the footer. */
  credits: string[];
}

export interface OfficeOptions {
  stage: HTMLElement;
  model: OfficeModel;
  host: Host;
  /** Force the CC0 tower view even if the pack is installed. */
  forceTower?: boolean;
}

const CC0_CREDITS = ['Pixel Office by 2dPig (CC0)', 'MetroCity people by JIK-A-4 (CC0)'];

export async function createOffice({ stage, model, host, forceTower = false }: OfficeOptions): Promise<Office> {
  const [imgs, pack] = await Promise.all([loadAll(), forceTower ? Promise.resolve(null) : loadPack()]);
  const view = pack ? createMegaView({ stage, imgs, pack, model, host }) : createTowerView({ stage, imgs, model, host });
  model.attach(view);
  return { view, credits: pack ? [pack.credit, ...CC0_CREDITS] : CC0_CREDITS };
}
