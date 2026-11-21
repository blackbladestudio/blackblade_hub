import type { BuilderSite } from '../../types/ipc';
import { toast } from '../utils';

export function initBuilder(): void {
  const entry = document.querySelector<HTMLButtonElement>('#card-builder')!;
  const back = document.querySelector<HTMLButtonElement>('#builder-back')!;
  const home = document.querySelector('main')!;
  const page = document.getElementById('builder-page')!;
  const refresh = document.querySelector<HTMLButtonElement>('#builder-refresh')!;
  const search = document.querySelector<HTMLInputElement>('#builder-search')!;
  const grid = document.getElementById('builder-grid')!;
  const status = document.getElementById('builder-status')!;
  let sites: BuilderSite[] | null = null;
  let request = 0;

  function card(site: BuilderSite): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'builder-card';
    const icon = document.createElement('span');
    icon.className = 'builder-card-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = Array.from(site.slug)[0].toLocaleUpperCase();
    if (site.iconUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.onload = () => icon.replaceChildren(image);
      image.src = site.iconUrl;
    }
    const info = document.createElement('span');
    info.className = 'builder-card-info';
    const title = document.createElement('strong');
    title.textContent = site.title;
    const author = document.createElement('span');
    author.textContent = site.author;
    info.append(title, author);
    const arrow = document.createElement('span');
    arrow.className = 'builder-card-arrow';
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    button.append(icon, info, arrow);
    button.addEventListener('click', () => {
      void window.studioHub.openBuilderSite(site.slug).catch(() => toast('无法打开站点，请重试。'));
    });
    return button;
  }

  function draw(): void {
    if (!sites) return;
    const query = search.value.trim().toLocaleLowerCase();
    const matches = sites.filter(({title, author}) => [title, author].some(text => text.toLocaleLowerCase().includes(query)));
    grid.replaceChildren(...matches.map(card));
    status.textContent = matches.length ? `${matches.length} 个站点` : query ? '没有匹配的站点。' : '还没有已发布的站点。';
  }

  async function load(): Promise<void> {
    const id = ++request;
    sites = null;
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'true');
    status.textContent = '正在加载站点…';
    refresh.disabled = true;
    try {
      const result = await window.studioHub.listBuilderSites();
      if (id !== request) return;
      sites = result;
      draw();
    } catch {
      if (id === request) status.textContent = '无法加载站点。请确认已连接工作室内网或 VPN，再点刷新。';
    } finally {
      if (id === request) {
        refresh.disabled = false;
        grid.removeAttribute('aria-busy');
      }
    }
  }

  entry.addEventListener('click', () => {
    home.inert = true;
    page.classList.remove('page-hidden');
    search.value = '';
    back.focus();
    void load();
  });
  back.addEventListener('click', () => {
    request++;
    page.classList.add('page-hidden');
    home.inert = false;
    entry.focus({ preventScroll: true });
  });
  refresh.addEventListener('click', () => void load());
  search.addEventListener('input', draw);
}
