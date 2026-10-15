/** Runs in a separate JS world. Page scripts cannot replace the ref map or its methods.
 * Pointer artwork: Lucide mouse-pointer-2, ISC, copyright (c) 2026 Lucide Icons and Contributors.
 * See the bundled THIRD_PARTY_NOTICES for its license.
 */
export function browserPage(command: string, args: Record<string, any>) {
  type Target = Element;
  /** What a screenshot promises: the viewport it shows, and what stood in each of its cells. */
  type Capture = {
    id: string;
    state: {
      document: string;
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
    };
    /** The side of one cell in CSS pixels, and the grid of them over the viewport. */
    cell: number;
    cols: number;
    rows: number;
    cells: string[];
    /** Every element the picture is made of, by what it is; null when the page was too big. */
    seen: Map<string, number[][]> | null;
  };
  type State = {
    refs: Map<string, Target>;
    // A ref stays with its element for the life of the document; numbers are never reused.
    ids: WeakMap<Target, string>;
    next: number;
    snapshots: number;
    document: string;
    /** The screenshot this page last agreed to be checked against. */
    capture?: Capture;
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
    document: `${Date.now()}-${Math.random()}`,
    x: 24,
    y: 24,
  });
  // What a screenshot is a picture of: this document, at this size, at this scroll.
  // Everything a page does to itself elsewhere is checked where it matters instead:
  // at the point that gets clicked. A dashboard that redraws a chart every second can
  // still be clicked, and a page that moved the picture cannot.
  const viewportState = () => ({
    document: state.document,
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
  });
  if (command === 'capture-state') return viewportState();
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
        el.textContent ||
        iconName(el),
    ).slice(0, 500);
  };
  // The name is the field's placeholder, a hint at what to type rather than a label
  const hint = (el: Element) => {
    const field = el as HTMLInputElement;
    return (
      !!el.getAttribute('placeholder') &&
      !el.getAttribute('aria-label') &&
      !el.getAttribute('aria-labelledby') &&
      !field.labels?.length &&
      !el.getAttribute('alt') &&
      !el.getAttribute('title')
    );
  };
  // An icon button often says what it is in its class alone: el-icon-more,
  // anticon-ellipsis. Name it for that rather than for nothing, so a snapshot line reads
  // `[e88] i "more"` and the model and the person can both tell which control it is.
  const iconName = (el: Element) => {
    for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
      const found = /(?:icon|glyph)[-_.]?([a-z][a-z0-9]*)/i.exec(token);
      if (found?.[1]) return found[1];
    }
    return '';
  };
  const role = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      return type === 'password'
        ? 'password'
        : type === 'file'
          ? 'file'
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
  // The text an element holds itself, not what its children hold.
  const ownText = (el: Element) => {
    let text = '';
    for (const node of Array.from(el.childNodes))
      if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue || '';
    return text;
  };
  // Marks, not words: an ellipsis, a plus, an icon font's own code point, or nothing at all.
  const MARK = /^[\s\p{P}\p{S}\p{Co}]*$/u;
  // The small pointer element inside a bigger one is what a person aims at: the "…" that
  // opens a row's menu, not the row whose cursor it inherits. A click on it reaches the
  // container's own handler, so the container keeps its ref too and nothing is hidden. A
  // leaf that spells a word is the container's label, and the container is the ref.
  const pointerLeaf = (el: Element) => {
    if (
      (el as SVGElement).ownerSVGElement ||
      (el.localName !== 'svg' && el.children.length)
    )
      return false;
    if (el.ownerDocument.defaultView!.getComputedStyle(el).cursor !== 'pointer')
      return false;
    if (!MARK.test(ownText(el).trim())) return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 && rect.width <= 64 && rect.height > 0 && rect.height <= 64
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
    ownPointer(el) ||
    pointerLeaf(el);
  // Inside a link or a button only real controls, explicit handlers and the small pointer
  // icon of a bigger container act on their own.
  const nestedAction = (el: Element) =>
    control(el) ||
    ROLES.includes(el.getAttribute('role') ?? '') ||
    el.hasAttribute('onclick') ||
    pointerLeaf(el);
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
        'a password field takes only a saved secret written as %NAME%; ask the user to save one, or to type the password in the browser',
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
  // What a warning page's control decides: Circle's own warning marks its controls, and
  // Chrome's (the terminal's browser) has its advanced button and proceed link. Other pages
  // decide nothing.
  const warningAction = (el: Element): string =>
    location.protocol === 'circle-warning:'
      ? (el
          .closest('[data-circle-action]')
          ?.getAttribute('data-circle-action') ?? '')
      : location.protocol !== 'chrome-error:'
        ? ''
        : el.closest('#proceed-link')
          ? 'proceed'
          : el.closest('#details-button')
            ? 'advanced'
            : '';
  if (command === 'snapshot') {
    state.refs.clear();
    const fresh = state.snapshots++ > 0;
    let length = 0;
    let truncated = false;
    const lines: string[] = [];
    // A ref is what an action needs, so a page too wordy for the snapshot keeps a second
    // allowance for its controls: what gets dropped is the text, never what can be clicked.
    const LIMIT = 30000;
    const CONTROL_LIMIT = LIMIT + 8000;
    const add = (line: string, control = false) => {
      const remaining = (control ? CONTROL_LIMIT : LIMIT) - length;
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
        length >= CONTROL_LIMIT
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
        // A file input: what it takes and the names of the files chosen, never a path
        const file = el.localName === 'input' && value.type === 'file';
        const content = password
          ? value.value
            ? ' filled'
            : ' empty'
          : file
            ? `${value.accept ? ` accepts ${JSON.stringify(value.accept)}` : ''}${value.multiple ? ' multiple' : ''}${
                value.files?.length
                  ? ` chosen ${Array.from(value.files)
                      .map((chosen) => JSON.stringify(chosen.name))
                      .join(', ')}`
                  : ' no file chosen'
              }`
            : ['input', 'textarea', 'select'].includes(el.localName)
              ? ` value=${JSON.stringify(clean(value.value))}`
              : '';
        // On a certificate warning, what its advanced button and its link to proceed are,
        // in any language: a replayed script's proceed step finds them so
        const warning = warningAction(el);
        add(
          `${indent}[${ref}] ${role(el)} ${JSON.stringify(name(el))}${content}${value.disabled ? ' disabled' : ''}${value.checked ? ' checked' : ''}${added ? ' [new]' : ''}${warning === 'advanced' || warning === 'proceed' ? ` [warning: ${warning}]` : ''}`,
          true,
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
        const row = indent + '| ' + cells.join(' | ') + ' |';
        add(row, /\[e[0-9]+\]/.test(row));
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
  // ---- what a screenshot shows, cell by cell
  const hash = (value: string) => {
    let h = 2166136261;
    for (let index = 0; index < value.length; index++) {
      h ^= value.charCodeAt(index);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  };
  // How far a busy page may nudge a control between the picture and the click: a table that
  // redraws beside the target moves it by a few pixels, and the click still lands on it.
  const SHIFT = 12;
  /** What the picture shows of one element: its kind and its own text. Not which element it
   * is: a page that builds the same control again, as a component library re-rendering a
   * table, shows the same picture and stays clickable. */
  const mark = (el: Element) => {
    let children = 0;
    for (const child of Array.from(el.children))
      if (!child.hasAttribute('data-circle-browser-overlay')) children++;
    return el.localName + ' ' + children + ' ' + hash(ownText(el));
  };
  const box = (rect: DOMRect) =>
    [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n));
  const stayed = (before: number[], after: number[]) =>
    before.length === after.length &&
    before.every(
      (value, index) => Math.abs(value - (after[index] ?? 1e9)) <= SHIFT,
    );
  /** What stands at one point of the picture: what it is, and where it stands. */
  const look = (x: number, y: number) => {
    const el = hit(document, x, y);
    return el
      ? mark(el) + ' ' + box(el.getBoundingClientRect()).join(',')
      : 'nothing';
  };
  /** Whether two readings of one point show the same thing, allow for a small nudge. */
  const same = (before: string, after: string) => {
    if (before === after) return true;
    const split = (value: string) => {
      const at = value.lastIndexOf(' ');
      return [
        value.slice(0, at),
        value
          .slice(at + 1)
          .split(',')
          .map(Number),
      ] as const;
    };
    const [one, first] = split(before);
    const [two, second] = split(after);
    return (
      one === two && first.length === second.length && stayed(first, second)
    );
  };
  /**
   * Every element the picture is made of, by what it is and where it stands. The cells
   * sample the viewport, so a control smaller than a cell can fall between them: this is
   * what says whether the thing under a point was drawn there at all. A page too big for
   * its time budget gives up the extra check rather than refusing every click on it.
   */
  const appearances = () => {
    const seen = new Map<string, number[][]>();
    let counted = 0;
    const stop = performance.now() + 600;
    const walk = (el: Element, depth: number): boolean => {
      if (depth > 80 || ++counted > 12000 || performance.now() > stop)
        return false;
      if (el.hasAttribute('data-circle-browser-overlay')) return true;
      const style = el.ownerDocument.defaultView!.getComputedStyle(el);
      if (style.display === 'none') return true;
      if (style.visibility !== 'hidden' && style.visibility !== 'collapse') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const what = mark(el);
          const at = seen.get(what);
          if (at) at.push(box(rect));
          else seen.set(what, [box(rect)]);
        }
      }
      for (const child of Array.from(el.children))
        if (!walk(child, depth + 1)) return false;
      const shadow = el.shadowRoot;
      if (shadow)
        for (const child of Array.from(shadow.children))
          if (!walk(child, depth + 1)) return false;
      if (['iframe', 'frame'].includes(el.localName)) {
        const doc = (el as HTMLIFrameElement).contentDocument;
        if (doc?.documentElement && !walk(doc.documentElement, depth + 1))
          return false;
      }
      return true;
    };
    return walk(document.documentElement, 0) ? seen : null;
  };
  if (command === 'capture') {
    // One hit test per cell of the viewport, about 1200 of them and a few milliseconds.
    // Cells below the time limit simply go unchecked, as on a page that never rests.
    const cell = Math.max(
      24,
      Math.ceil(Math.sqrt((innerWidth * innerHeight) / 1200)),
    );
    const cols = Math.max(1, Math.ceil(innerWidth / cell));
    const cells: string[] = [];
    const stop = performance.now() + 1000;
    for (let row = 0; row < Math.ceil(innerHeight / cell); row++) {
      if (cells.length && performance.now() > stop) break;
      for (let col = 0; col < cols; col++)
        cells.push(look((col + 0.5) * cell, (row + 0.5) * cell));
    }
    state.capture = {
      id: String(args.id),
      state: viewportState(),
      cell,
      cols,
      rows: cells.length / cols,
      cells,
      seen: appearances(),
    };
    return state.capture.state;
  }
  /**
   * Whether the cell a point falls in still shows what the picture showed there. One cell,
   * not the page around it: a device WebUI redraws the cell next to the control being
   * clicked every second, and that says nothing about what stands under the point.
   */
  const unchanged = (capture: Capture, x: number, y: number) => {
    const col = Math.floor(x / capture.cell),
      row = Math.floor(y / capture.cell),
      index = row * capture.cols + col;
    // A cell the capture never reached cannot be checked, as on a page that never rests.
    const recorded = capture.cells[index];
    if (col >= capture.cols || recorded === undefined) return true;
    return same(
      recorded,
      look((col + 0.5) * capture.cell, (row + 0.5) * capture.cell),
    );
  };
  if (command === 'point') {
    const x = Number(args.x),
      y = Number(args.y);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= innerWidth ||
      y >= innerHeight
    )
      throw Error('click coordinates are outside the viewport');
    const capture = state.capture;
    if (!capture || capture.id !== String(args.screenshotId))
      throw Error('the screenshot is stale; take a new browser_screenshot');
    if (JSON.stringify(viewportState()) !== JSON.stringify(capture.state))
      throw Error(
        'the screenshot is stale: the page scrolled, resized or changed document; take a new browser_screenshot',
      );
    if (!unchanged(capture, x, y))
      throw Error(
        `the screenshot is stale: the page changed at (${x}, ${y}); take a new browser_screenshot, or act on a ref from browser_snapshot`,
      );
    let doc = document,
      localX = x,
      localY = y;
    let el = hit(doc, localX, localY);
    for (
      let depth = 0;
      el && ['iframe', 'frame'].includes(el.localName) && depth < 20;
      depth++
    ) {
      const frame = el as HTMLIFrameElement;
      const child = frame.contentDocument;
      if (!child)
        throw Error(
          'coordinate clicks cannot inspect a cross-origin frame; open its address as a page first',
        );
      const rect = frame.getBoundingClientRect();
      localX =
        (localX - rect.left) /
          (rect.width / (frame.offsetWidth || rect.width)) -
        frame.clientLeft;
      localY =
        (localY - rect.top) /
          (rect.height / (frame.offsetHeight || rect.height)) -
        frame.clientTop;
      doc = child;
      el = hit(doc, localX, localY);
    }
    if (!el || hidden(el))
      throw Error('there is no visible element at these coordinates');
    // The cell says nothing over here moved; this says the thing under the point is what
    // the picture drew, however small it is.
    const drawn = capture.seen?.get(mark(el));
    const here = box(el.getBoundingClientRect());
    if (!drawn?.some((before) => stayed(before, here)))
      throw Error(
        `the screenshot is stale: the page changed at (${x}, ${y}); take a new browser_screenshot, or act on a ref from browser_snapshot`,
      );
    let target = el;
    for (
      let node: Element | null = el;
      node && node.ownerDocument === doc;
      node = parent(node)
    ) {
      if (actionable(node)) {
        target = node;
        break;
      }
    }
    if (target.matches(':disabled') || target.closest('[inert]'))
      throw Error('the element is disabled');
    let ref = state.ids.get(target);
    if (!ref) {
      ref = `e${++state.next}`;
      state.ids.set(target, ref);
    }
    state.refs.set(ref, target);
    return {
      ref,
      x,
      y,
      width: 1,
      height: 1,
      role: role(target),
      name: name(target),
      known: actionable(target),
      origin: target.ownerDocument.location.origin,
    };
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
      // The element as the snapshot shows it, read as the action uses it
      role: role(el),
      name: name(el),
      hint: hint(el),
      origin: el.ownerDocument.location.origin,
      password:
        el.localName === 'input' &&
        (el as HTMLInputElement).type === 'password',
      action: warningAction(el),
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
    // A key on the warning's proceed link would go past it without the user's approval
    const target = focused();
    if (
      ['Enter', 'Space'].includes(String(args.key)) &&
      target &&
      warningAction(target) === 'proceed'
    )
      throw Error(
        'to proceed past a certificate warning, click its link with browser_click',
      );
    return true;
  }
  // Marks a file input for the browser to find (`token`), or unmarks it: page scripts may
  // see the attribute for a moment, never the files
  if (command === 'file-input') {
    const el = field() as HTMLInputElement;
    if (el.localName !== 'input' || el.type !== 'file')
      throw Error(
        'the element is not a file input; click what opens the file chooser, then use browser_upload',
      );
    if (el.disabled) throw Error('the element is disabled');
    if (args.token) el.setAttribute('data-circle-file', String(args.token));
    else el.removeAttribute('data-circle-file');
    return {
      multiple: el.multiple,
      accept: el.accept,
      role: role(el),
      name: name(el),
      origin: el.ownerDocument.location.origin,
    };
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
      // Built element by element: a page that requires Trusted Types refuses markup
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      for (const [name, value] of [
        ['viewBox', '0 0 24 24'],
        ['width', '24'],
        ['height', '24'],
      ] as const)
        svg.setAttribute(name, value);
      const path = document.createElementNS(svgNs, 'path');
      for (const [name, value] of [
        [
          'd',
          'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z',
        ],
        ['fill', 'currentColor'],
        ['stroke', String(args.background)],
        ['stroke-width', '1.7'],
        ['stroke-linejoin', 'round'],
      ] as [string, string][])
        path.setAttribute(name, value);
      svg.append(path);
      pointer.append(svg);
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

/**
 * The expression that runs one command of the page script in a page and reports how it
 * went. A compiler that names functions (`__name`, as tsx and esbuild's keepNames add)
 * would leave a call the page does not have; the expression brings a stand-in.
 */
export function pageCall(command: string, args: Record<string, unknown>) {
  return `(async () => { const __name = (target) => target; try { return { ok: true, value: await (${browserPage.toString()})(${JSON.stringify(command)},${JSON.stringify(args)}) }; } catch (error) { return { ok: false, error: String(error.message || error) }; } })()`;
}
