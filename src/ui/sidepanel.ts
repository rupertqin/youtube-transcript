import type { TranscriptClient } from '../platform/types';
import { createPanel, type PanelHandle } from './panel';

/** Side Panel 文档里的唯一挂载点。 */
export function mountSidePanel(container: HTMLElement, client: TranscriptClient): PanelHandle {
  const panel = createPanel({ client, variant: 'sidepanel' });
  container.appendChild(panel.element);
  return panel;
}
