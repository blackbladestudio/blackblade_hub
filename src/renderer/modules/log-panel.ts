let logHook: ((type: string, msg: string) => void) | null = null;

export function initLogPanel(): void {
  document.getElementById('btn-toggle-log')!.addEventListener('click', toggleLogPanel);
  document.getElementById('btn-close-log')!.addEventListener('click', closeLogPanel);
}

export function showLogPanel(): void {
  const panel = document.getElementById('log-panel')!;
  document.getElementById('log-content')!.innerHTML = '';
  panel.classList.add('visible');
}

export function closeLogPanel(): void {
  document.getElementById('log-panel')!.classList.remove('visible');
}

function toggleLogPanel(): void {
  document.getElementById('log-panel')!.classList.toggle('visible');
}

export function appendLog(type: string, msg: string): void {
  const content = document.getElementById('log-content')!;
  const line = document.createElement('div');
  line.className = 'log-' + type;
  line.textContent = msg;
  content.appendChild(line);
  content.scrollTop = content.scrollHeight;
  if (logHook) logHook(type, msg);
}

export function setLogHook(hook: ((type: string, msg: string) => void) | null): void {
  logHook = hook;
}
