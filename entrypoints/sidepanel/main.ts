import '../../src/ui/styles.css';
import { createRemoteClient } from '../../src/platform/client.sidepanel-chrome';
import { getPrefs, loadPrefs, resolveTheme, subscribePrefs } from '../../src/ui/prefs';
import { mountSidePanel } from '../../src/ui/sidepanel';

const container = document.getElementById('root');
if (!container) throw new Error('side panel root missing');

mountSidePanel(container, createRemoteClient());

/** 侧栏文档自己的背景跟着主题走，避免打开时闪白。 */
function paintBackground(): void {
  const theme = resolveTheme(getPrefs().theme);
  document.documentElement.dataset.theme = theme;
  document.body.style.background = theme === 'light' ? '#ffffff' : '#0f0f10';
}

paintBackground();
void loadPrefs().then(paintBackground);
subscribePrefs(paintBackground);
