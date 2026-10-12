/** Runs in a separate JS world. Page scripts cannot replace the ref map or its methods.
 * Pointer artwork: Lucide mouse-pointer-2, ISC, copyright (c) 2026 Lucide Icons and Contributors.
 * See the bundled THIRD_PARTY_NOTICES for its license.
 */
export function browserPage(command: string, args: Record<string, any>) {
  type Target = Element;
  type State = {
    refs: Map<string, Target>;
    // A ref stays with its element for the life of the document; numbers are never reused.
    ids: WeakMap<Target, string>;
    next: number;
    snapshots: number;
    overlay?: HTMLElement;
    pointer?: HTMLElement;
    bubble?: HTMLElement;
    highlight?: HTMLElement;
    timer?: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  };
  const world = window as typeof window & {
    circleBrowser?: State;
  };
  const state: State = (world.circleBrowser ??= {
    refs: new Map(),
    ids: new WeakMap(),
    next: 0,
    snapshots: 0,
    x: 24,
    y: 24,
  });
  const deadline = performance.now() + 2000;
  let visited = 0;
  const clean = (value: string | null | undefined) =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const parent = (el: Element): Element | null => {
    if (el.assignedSlot) return el.assignedSlot;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE)
      return (root as ShadowRoot).host ?? null;
    try {
      return el.ownerDocument.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
  };
  const hidden = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = parent(node)) {
      const style = node.ownerDocument.defaultView!.getComputedStyle(node);
      if (
        node.hasAttribute('data-circle-browser-overlay') ||
        (node.localName === 'input' &&
          (node as HTMLInputElement).type === 'hidden') ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0 ||
        style.contentVisibility === 'hidden'
      )
        return true;
    }
    return false;
  };
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return (
      !hidden(el) &&
      rect.width > 0 &&
      rect.height > 0 &&
      el.getClientRects().length > 0
    );
  };
  const name = (el: Element) => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const labelled = el
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => root.getElementById?.(id)?.textContent ?? '')
      .join(' ');
    const field = el as HTMLInputElement;
    return clean(
      el.getAttribute('aria-label') ||
        labelled ||
        (field.labels
          ? Array.from(field.labels)
              .map((label) => label.textContent)
              .join(' ')
          : '') ||
        el.getAttribute('alt') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (['submit', 'button', 'reset'].includes(field.type)
          ? field.value
          : '') ||
        (el as HTMLElement).innerText ||
        el.textContent,
    ).slice(0, 500);
  };
  const role = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      return type === 'password'
        ? 'password'
        : ['button', 'submit', 'reset', 'image'].includes(type)
          ? 'button'
          : ['checkbox', 'radio'].includes(type)
            ? type
            : 'textbox';
    }
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'textarea' || (el as HTMLElement).isContentEditable)
      return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return (
      (
        { th: 'columnheader', td: 'cell', tr: 'row', img: 'image' } as Record<
          string,
          string
        >
      )[tag] || tag
    );
  };
  const ROLES = [
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'tab',
    'menuitem',
    'option',
    'switch',
    'slider',
    'spinbutton',
  ];
  // Only a pointer cursor an element sets itself counts: children inherit it.
  const ownPointer = (el: Element) => {
    const view = el.ownerDocument.defaultView!;
    if (view.getComputedStyle(el).cursor !== 'pointer') return false;
    const above = parent(el);
    return (
      !above ||
      above.ownerDocument !== el.ownerDocument ||
      view.getComputedStyle(above).cursor !== 'pointer'
    );
  };
  const control = (el: Element) =>
    ['button', 'a', 'input', 'textarea', 'select', 'summary'].includes(
      el.localName,
    );
  const actionable = (el: Element) =>
    control(el) ||
    ROLES.includes(el.getAttribute('role') ?? '') ||
    (el as HTMLElement).isContentEditable ||
    el.hasAttribute('onclick') ||
    typeof (el as HTMLElement).onclick === 'function' ||
    (el.hasAttribute('tabindex') && (el as HTMLElement).tabIndex >= 0) ||
    ownPointer(el);
  // Inside a link or a button only real controls and explicit handlers act on their own.
  const nestedAction = (el: Element) =>
    control(el) ||
    ROLES.includes(el.getAttribute('role') ?? '') ||
    el.hasAttribute('onclick');
  const composedContains = (
    parent: Element,
    child: Element | null,
  ): boolean => {
    for (let node: Node | null = child; node;) {
      if (node === parent) return true;
      node =
        (node as Element).assignedSlot ||
        node.parentNode ||
        (node as ShadowRoot).host ||
        null;
    }
    return false;
  };
  const hit = (
    root: Document | ShadowRoot,
    x: number,
    y: number,
  ): Element | null => {
    let el = root.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const next = el.shadowRoot.elementFromPoint(x, y);
      if (!next || next === el) break;
      el = next;
    }
    return el;
  };
  const field = () => {
    const el = state.refs.get(String(args.ref));
    if (!el?.isConnected)
      throw Error('the element ref is stale; take a new browser_snapshot');
    if (!visible(el))
      throw Error('the element is hidden; take a new browser_snapshot');
    return el;
  };
  const rejectPassword = (el: Element | null) => {
    if (
      el?.localName === 'input' &&
      (el as HTMLInputElement).type === 'password'
    )
      throw Error(
        'password fields cannot be filled by the model; ask the user to enter the password in the browser panel',
      );
  };
  const focused = (): Element | null => {
    let el: Element | null = document.activeElement;
    for (let depth = 0; el && depth < 20; depth++) {
      const next: Element | null =
        el.shadowRoot?.activeElement ||
        (['iframe', 'frame'].includes(el.localName)
          ? ((el as HTMLIFrameElement).contentDocument?.activeElement ?? null)
          : null);
      if (!next || next === el) break;
      el = next;
    }
    return el;
  };
  if (command === 'snapshot') {
    state.refs.clear();
    const fresh = state.snapshots++ > 0;
    let length = 0;
    let truncated = false;
    const lines: string[] = [];
    const add = (line: string) => {
      const remaining = 30000 - length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (line.length + 1 > remaining) truncated = true;
      const text = line.slice(0, Math.max(0, remaining - 1));
      lines.push(text);
      length += text.length + 1;
    };
    const walk = (
      node: Node,
      indent = '',
      suppressText = false,
      inAction = false,
    ) => {
      if (
        ++visited > 15000 ||
        performance.now() > deadline ||
        length >= 30000
      ) {
        truncated = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const root = node.getRootNode();
        const container =
          node.parentElement ??
          (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
            ? (root as ShadowRoot).host
            : null);
        if (suppressText || !container || hidden(container)) return;
        const range = node.ownerDocument!.createRange();
        range.selectNodeContents(node);
        if (
          !Array.from(range.getClientRects()).some(
            (rect) => rect.width > 0 && rect.height > 0,
          )
        )
          return;
        const text = clean(node.textContent);
        if (text) add(indent + text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (
        ['script', 'style', 'noscript', 'template'].includes(el.localName) ||
        hidden(el)
      )
        return;
      const isVisible = visible(el);
      const isAction =
        isVisible && actionable(el) && (!inAction || nestedAction(el));
      let ref = '';
      let added = false;
      if (isAction) {
        ref = state.ids.get(el) ?? '';
        if (!ref) {
          ref = `e${++state.next}`;
          state.ids.set(el, ref);
          added = fresh;
        }
        state.refs.set(ref, el);
      }
      const value = el as HTMLInputElement;
      if (isAction) {
        const password = value.type === 'password';
        const content = password
          ? value.value
            ? ' filled'
            : ' empty'
          : ['input', 'textarea', 'select'].includes(el.localName)
            ? ` value=${JSON.stringify(clean(value.value))}`
            : '';
        add(
          `${indent}[${ref}] ${role(el)} ${JSON.stringify(name(el))}${content}${value.disabled ? ' disabled' : ''}${value.checked ? ' checked' : ''}${added ? ' [new]' : ''}`,
        );
      } else if (
        isVisible &&
        (/^h[1-6]$/.test(el.localName) || el.localName === 'img')
      ) {
        add(`${indent}${role(el)} ${JSON.stringify(name(el))}`);
        return;
      }
      if (['iframe', 'frame'].includes(el.localName)) {
        if (!isVisible) return;
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc?.documentElement) {
            add(indent + `frame ${JSON.stringify(doc.URL)}`);
            walk(doc.body || doc.documentElement, indent + '  ');
          } else add(indent + 'frame (cross-origin content unavailable)');
        } catch {
          add(indent + 'frame (cross-origin content unavailable)');
        }
        return;
      }
      if (el.localName === 'select') {
        const options = (el as HTMLSelectElement).options;
        add(
          indent +
            '  options: ' +
            Array.from(options)
              .slice(0, 500)
              .map(
                (option) =>
                  `${JSON.stringify(clean(option.value))}=${JSON.stringify(clean(option.text))}${option.selected ? ' selected' : ''}${option.disabled || (option.parentElement?.localName === 'optgroup' && (option.parentElement as HTMLOptGroupElement).disabled) ? ' disabled' : ''}`,
              )
              .join(', '),
        );
        if (options.length > 500) add(indent + '  … options truncated');
        return;
      }
      if (el.localName === 'tr') {
        const start = lines.length;
        const before = length;
        for (const child of Array.from(el.childNodes))
          walk(child, '', false, inAction);
        const cells = lines.splice(start);
        length = before;
        add(indent + '| ' + cells.join(' | ') + ' |');
        return;
      }
      // Interactive nodes already include their name; still visit interactive descendants.
      const children =
        el.localName === 'slot'
          ? (el as HTMLSlotElement).assignedNodes({ flatten: true })
          : Array.from(el.shadowRoot?.childNodes ?? el.childNodes);
      const nodes =
        children.length || el.localName !== 'slot'
          ? children
          : Array.from(el.childNodes);
      for (const child of nodes) {
        walk(child, indent, suppressText || isAction, inAction || isAction);
      }
    };
    walk(document.body || document.documentElement);
    return lines.join('\n') + (truncated ? '\n… snapshot truncated' : '');
  }
  if (command === 'prepare') {
    const el = field();
    // A secret the user saved for this site may go into a password field; text may not
    if (args.typing && !args.secret) rejectPassword(el);
    if (el.matches(':disabled') || el.closest('[inert]'))
      throw Error('the element is disabled');
    (el as HTMLElement).scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
    });
    let view = el.ownerDocument.defaultView!;
    const frames: HTMLIFrameElement[] = [];
    while (view !== window) {
      const frame = view.frameElement as HTMLIFrameElement | null;
      if (!frame) throw Error('the frame is no longer accessible');
      frame.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'instant',
      });
      frames.push(frame);
      view = frame.ownerDocument.defaultView!;
    }
    const rect = el.getBoundingClientRect();
    const own = el.ownerDocument.defaultView!;
    const left = Math.max(0, rect.left),
      right = Math.min(own.innerWidth, rect.right);
    const top = Math.max(0, rect.top),
      bottom = Math.min(own.innerHeight, rect.bottom);
    if (right <= left || bottom <= top)
      throw Error('the element is outside the viewport');
    let x = (left + right) / 2,
      y = (top + bottom) / 2;
    let width = right - left,
      height = bottom - top;
    const obstruction = hit(el.ownerDocument, x, y);
    if (!composedContains(el, obstruction))
      throw Error(
        `the element is covered by ${obstruction ? `${role(obstruction)} ${JSON.stringify(name(obstruction))}` : 'another element'}`,
      );
    for (const frame of frames) {
      const bounds = frame.getBoundingClientRect();
      const scaleX = bounds.width / (frame.offsetWidth || bounds.width);
      const scaleY = bounds.height / (frame.offsetHeight || bounds.height);
      x = bounds.left + (frame.clientLeft + x) * scaleX;
      y = bounds.top + (frame.clientTop + y) * scaleY;
      width *= scaleX;
      height *= scaleY;
      const obstruction = hit(frame.ownerDocument, x, y);
      if (!composedContains(frame, obstruction))
        throw Error(
          `the frame is covered by ${obstruction ? `${role(obstruction)} ${JSON.stringify(name(obstruction))}` : 'another element'}`,
        );
    }
    return {
      x,
      y,
      width,
      height,
      name: name(el),
      origin: el.ownerDocument.location.origin,
      password:
        el.localName === 'input' &&
        (el as HTMLInputElement).type === 'password',
      // Only Circle's own warning page marks its decisions
      action:
        location.protocol === 'circle-warning:'
          ? (el
              .closest('[data-circle-action]')
              ?.getAttribute('data-circle-action') ?? '')
          : '',
    };
  }
  if (command === 'focus') {
    const el = field();
    if (!args.secret) rejectPassword(el);
    if (
      !['input', 'textarea'].includes(el.localName) &&
      !(el as HTMLElement).isContentEditable
    )
      throw Error('the element is not an editable field');
    if (
      el.matches(':disabled') ||
      el.closest('[inert]') ||
      (el as HTMLInputElement).readOnly
    )
      throw Error('the field is not editable');
    if (
      el.localName === 'input' &&
      ![
        'text',
        'search',
        'email',
        'url',
        'tel',
        'number',
        ...(args.secret ? ['password'] : []),
      ].includes((el as HTMLInputElement).type)
    )
      throw Error('the field does not support text input');
    (el as HTMLElement).focus();
    if (focused() !== el) throw Error('the field could not be focused');
    if (['input', 'textarea'].includes(el.localName)) {
      const input = el as HTMLInputElement;
      if (input.type !== 'number') {
        try {
          input.select();
        } catch {
          throw Error('the field does not support text input');
        }
      }
    } else {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const selection = el.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }
  if (command === 'guard-type') {
    const el = field();
    if (!args.secret) {
      rejectPassword(el);
      rejectPassword(focused());
    }
    if (focused() !== el)
      throw Error('the field focus changed; take a new browser_snapshot');
    if (
      el.matches(':disabled') ||
      el.closest('[inert]') ||
      (el as HTMLInputElement).readOnly
    )
      throw Error('the field is not editable');
    if (
      (el.localName === 'input' &&
        ![
          'text',
          'search',
          'email',
          'url',
          'tel',
          'number',
          ...(args.secret ? ['password'] : []),
        ].includes((el as HTMLInputElement).type)) ||
      (!['input', 'textarea'].includes(el.localName) &&
        !(el as HTMLElement).isContentEditable)
    )
      throw Error('the field does not support text input');
    return true;
  }
  if (command === 'guard-key') {
    if (!args.secret) rejectPassword(focused());
    return true;
  }
  if (command === 'select') {
    const el = field() as HTMLSelectElement;
    if (el.localName !== 'select') throw Error('the element is not a select');
    if (el.disabled) throw Error('the element is disabled');
    const choices = args.values as string[];
    if (!el.multiple && choices.length !== 1)
      throw Error('this select accepts one option');
    const options = Array.from(el.options);
    const selected = choices.map((choice) => {
      const option = options.find(
        (option) => option.value === choice || clean(option.text) === choice,
      );
      if (
        !option ||
        option.disabled ||
        (option.parentElement?.localName === 'optgroup' &&
          (option.parentElement as HTMLOptGroupElement).disabled)
      )
        throw Error(`option unavailable: ${choice}`);
      return option;
    });
    for (const option of options) option.selected = selected.includes(option);
    const EventType = el.ownerDocument.defaultView!.Event;
    el.dispatchEvent(new EventType('input', { bubbles: true }));
    el.dispatchEvent(new EventType('change', { bubbles: true }));
    return true;
  }
  if (command === 'overlay-hidden') {
    if (state.overlay)
      state.overlay.style.setProperty(
        'visibility',
        args.hidden ? 'hidden' : 'visible',
        'important',
      );
    return true;
  }
  if (command === 'overlay') {
    if (!state.overlay?.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('data-circle-browser-overlay', '');
      host.style.cssText =
        'all:initial!important;display:block!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;transition:opacity 300ms!important';
      const shadow = host.attachShadow({ mode: 'closed' });
      const pointer = document.createElement('div');
      pointer.style.cssText =
        'position:absolute;left:-4px;top:-4px;width:24px;height:24px;transition:transform 450ms cubic-bezier(.2,.7,.2,1)';
      pointer.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" fill="currentColor" stroke="${args.background}" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
      const bubble = document.createElement('div');
      bubble.style.cssText =
        'position:absolute;padding:6px 10px;border-radius:8px;font:13px system-ui;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const highlight = document.createElement('div');
      highlight.style.cssText =
        'position:absolute;border:2px solid;border-radius:4px;box-sizing:border-box;display:none';
      shadow.append(highlight, pointer, bubble);
      document.documentElement.append(host);
      Object.assign(state, { overlay: host, pointer, bubble, highlight });
    }
    const { overlay, pointer, bubble, highlight } = state;
    clearTimeout(state.timer);
    overlay!.style.setProperty('opacity', '1', 'important');
    pointer!.style.color = args.foreground;
    pointer!.style.filter = `drop-shadow(0 1px 1px ${args.background})`;
    pointer!.querySelector('path')!.setAttribute('stroke', args.background);
    bubble!.style.background = args.background;
    bubble!.style.color = args.foreground;
    bubble!.style.border = `1px solid ${args.color}`;
    bubble!.textContent = String(args.label);
    const x = Number(args.x),
      y = Number(args.y);
    pointer!.style.transform = `translate(${state.x}px,${state.y}px)`;
    void pointer!.offsetWidth;
    pointer!.style.transform = `translate(${x}px,${y}px)`;
    bubble!.style.left = Math.max(4, Math.min(innerWidth - 290, x + 28)) + 'px';
    bubble!.style.top = Math.max(4, Math.min(innerHeight - 40, y + 18)) + 'px';
    highlight!.style.display = args.typing ? 'block' : 'none';
    highlight!.style.borderColor = args.color;
    highlight!.style.background = `color-mix(in srgb, ${args.tint} 15%, transparent)`;
    highlight!.style.left = x - args.width / 2 + 'px';
    highlight!.style.top = y - args.height / 2 + 'px';
    highlight!.style.width = args.width + 'px';
    highlight!.style.height = args.height + 'px';
    state.x = x;
    state.y = y;
    state.timer = setTimeout(() => {
      if (state.overlay)
        state.overlay.style.setProperty('opacity', '0', 'important');
    }, 6000);
    return new Promise((resolve) =>
      setTimeout(() => {
        if (args.click && state.pointer?.parentNode) {
          const ripple = document.createElement('div');
          ripple.style.cssText = `position:absolute;left:${x - 16}px;top:${y - 16}px;width:32px;height:32px;border:2px solid ${args.color};border-radius:50%`;
          state.pointer.parentNode.appendChild(ripple);
          ripple
            .animate(
              [
                { opacity: 1, transform: 'scale(.3)' },
                { opacity: 0, transform: 'scale(2)' },
              ],
              { duration: 650 },
            )
            .finished.then(() => ripple.remove());
        }
        resolve(true);
      }, 450),
    );
  }
  throw Error('unknown browser page command');
}
