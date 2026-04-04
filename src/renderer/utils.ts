export function toast(msg: string): void {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout((el as any)._timer);
  (el as any)._timer = setTimeout(() => el.classList.remove('show'), 2500);
}

export function setStatus(type: 'ok' | 'warning' | 'error', text: string): void {
  const dot = document.getElementById('status-dot')!;
  dot.className = 'status-dot ' + (type === 'ok' ? '' : type);
  document.getElementById('status-text')!.textContent = text;
}

export function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function addRipple(el: HTMLElement, e: MouseEvent): void {
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = e.clientX - rect.left - size / 2;
  const y = e.clientY - rect.top - size / 2;
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
  el.appendChild(ripple);
  setTimeout(() => ripple.remove(), 500);
}
