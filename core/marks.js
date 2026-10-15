(() => {
  if (window.jevMarks) return;
  let marked = [];
  const root = document.getElementById('jev-overlay') || document.createElement('div');
  root.id = 'jev-overlay';
  Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });

  function mount() { if (!root.isConnected) document.documentElement.append(root); }
  function overlay(className, styles, text) {
    mount();
    const el = document.createElement('div');
    el.className = className;
    Object.assign(el.style, { position: 'fixed', pointerEvents: 'none', ...styles });
    if (text != null) el.textContent = text;
    root.append(el);
    return el;
  }
  function remove() {
    for (const { element, label } of marked) { element.removeAttribute('data-jev-mark'); label.remove(); }
    marked = [];
  }
  function add({ scope, strict = false } = {}) {
    remove();
    mount();
    const area = scope ? document.querySelector(scope) : document;
    if (!area && strict) return [];
    for (const element of (area || document).querySelectorAll('button, a[href], [role="button"], input, select, [data-ticket-id]')) {
      if (root.contains(element)) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth || style.visibility === 'hidden' || style.display === 'none') continue;
      const id = `m${marked.length + 1}`;
      const label = overlay('jev-mark', {
        left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top)}px`,
        background: '#d93025', color: 'white', font: 'bold 12px/18px system-ui',
        minWidth: '18px', textAlign: 'center', borderRadius: '3px', boxShadow: '0 1px 4px #0008',
      }, String(marked.length + 1));
      element.dataset.jevMark = id;
      marked.push({ id, element, label });
    }
    return marked.map(({ id, element }, i) => {
      const { x, y, width: w, height: h } = element.getBoundingClientRect();
      return { id, label: String(i + 1), x, y, w, h };
    });
  }
  function cursor(x, y) {
    let el = root.querySelector('.jev-cursor');
    if (!el) el = overlay('jev-cursor', { left: '50vw', top: '50vh', width: '18px', height: '18px', border: '3px solid #d93025', borderRadius: '50%', boxShadow: '0 0 0 4px #d9302540', transition: 'left 150ms ease, top 150ms ease' });
    requestAnimationFrame(() => { el.style.left = `${x}px`; el.style.top = `${y}px`; });
  }
  async function click(id) {
    const element = marked.find(mark => mark.id === id)?.element;
    if (!element) return false;
    if (element.closest('[data-ticket-id]')) clearBox(); // opening another ticket: old evidence no longer applies
    const rect = element.getBoundingClientRect();
    cursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await new Promise(resolve => setTimeout(resolve, 160));
    element.click();
    return true;
  }
  function clearBox() { for (const old of root.querySelectorAll('.jev-box')) old.remove(); }
  function box(fracBox, text) {
    clearBox();
    const [x, y, w, h] = Array.isArray(fracBox) ? fracBox : [fracBox.x, fracBox.y, fracBox.w, fracBox.h];
    const el = overlay('jev-box', {
      left: `${x * innerWidth}px`, top: `${y * innerHeight}px`, width: `${w * innerWidth}px`, height: `${h * innerHeight}px`,
      border: '3px solid #d93025', borderRadius: '4px', boxSizing: 'border-box',
    });
    if (text) {
      const caption = document.createElement('span');
      caption.textContent = text;
      Object.assign(caption.style, { position: 'absolute', top: '-22px', left: '0', background: '#d93025', color: 'white', font: '12px system-ui', padding: '2px 5px' });
      el.append(caption);
    }
  }
  function toast(text) {
    root.querySelector('.jev-toast')?.remove();
    overlay('jev-toast', { right: '20px', top: '56px', maxWidth: '360px', background: '#202124f2', color: 'white', padding: '12px 16px', borderRadius: '10px', font: '14px/1.5 system-ui', whiteSpace: 'pre-line', boxShadow: '0 8px 24px #0005', borderLeft: '4px solid #d93025' }, text);
  }
  function hideOverlay() { for (const child of root.children) if (!child.classList.contains('jev-mark')) child.style.visibility = 'hidden'; }
  function showOverlay() { for (const child of root.children) child.style.visibility = ''; }
  window.jevMarks = { add, remove, click, box, clearBox, toast, cursor, hideOverlay, showOverlay };
})();
