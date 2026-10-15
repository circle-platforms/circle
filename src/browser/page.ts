/** Runs in a separate JS world. Page scripts cannot replace the ref map or its methods.
 * Pointer artwork: Lucide mouse-pointer-2, ISC, copyright (c) 2026 Lucide Icons and Contributors.
 * See the bundled THIRD_PARTY_NOTICES for its license.
 */
export function browserPage(command: string, args: Record<string, any>) {
  type Target = Element;
  // Where an element was, and whether it could be seen and take a click there
  type Box = [
    left: number,
    top: number,
    right: number,
    bottom: number,
    shown: boolean,
  ];
  type State = {
    refs: Map<string, Target>;
    // A ref stays with its element for the life of the document; numbers are never reused.
    ids: WeakMap<Target, string>;
    next: number;
    snapshots: number;
    document: string;
    revision: number;
    observer?: MutationObserver;
    observedRoots?: WeakSet<Node>;
    // The revision of each node's last change, and of its last change beyond the restyling
    // a hover makes (its class, style or tooltip reference)
    touched: WeakMap<Node, number>;
    altered: WeakMap<Node, number>;
    // Where the elements in view were when the last screenshots were taken
    captures: { id: string; revision: number; boxes: Map<Element, Box> }[];
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
    revision: 0,
    touched: new WeakMap(),
    altered: new WeakMap(),
    captures: [],
    x: 24,
    y: 24,
  });
  const HOVER_ATTRIBUTES = [
    'class',
    'style',
    'aria-describedby',
    'data-state',
    'data-hover',
    'data-hovered',
    'data-highlighted',
  ];
  // Each change is kept with the nodes it touched: a coordinate click judges the area it
  // clicks, not the whole page
  const observe = (records: MutationRecord[]) => {
    let counted = false;
    for (const record of records) {
      const target =
        record.target.nodeType === Node.ELEMENT_NODE
          ? (record.target as Element)
          : record.target.parentElement;
      if (target?.closest('[data-circle-browser-overlay]')) continue;
      const changed = [
        ...Array.from(record.addedNodes),
        ...Array.from(record.removedNodes),
      ];
      if (
        changed.length &&
        changed.every(
          (node) =>
            node.nodeType === Node.ELEMENT_NODE &&
            (node as Element).hasAttribute('data-circle-browser-overlay'),
        )
      )
        continue;
      if (!counted) {
        state.revision++;
        counted = true;
      }
      for (const node of [record.target, target]) {
        if (!node) continue;
        state.touched.set(node, state.revision);
        if (
          record.type !== 'attributes' ||
          !HOVER_ATTRIBUTES.includes(record.attributeName ?? '')
        )
          state.altered.set(node, state.revision);
      }
    }
  };
  if (!state.observer) {
    state.observer = new MutationObserver(observe);
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    state.observedRoots = new WeakSet([document]);
    document.addEventListener('visibilitychange', () => state.revision++);
    document.addEventListener(
      'scroll',
      (event) => {
        // Main viewport offsets are compared directly; late viewport events must not
        // invalidate an otherwise current capture. Nested containers have no such fields.
        if (event.target !== document) state.revision++;
      },
      true,
    );
  }
  // Drawn: not hidden by display, visibility or opacity, its own or an ancestor's
  const seen = (el: Element) =>
    typeof el.checkVisibility !== 'function' ||
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  /**
   * The page as a screenshot shows it: its document, viewport and scroll. With `record`,
   * also where each element in view is, for coordinate clicks to check their area.
   */
  const captureState = (record = false) => {
    const boxes = new Map<Element, Box>();
    const roots = (root: Document | ShadowRoot, depth = 0) => {
      if (depth > 20) return;
      const view =
        root.nodeType === Node.DOCUMENT_NODE
          ? (root as Document).defaultView
          : (root as ShadowRoot).host.ownerDocument.defaultView;
      for (const el of Array.from(root.querySelectorAll('*')).slice(0, 15000)) {
        if (el.hasAttribute('data-circle-browser-overlay')) continue;
        if (record && view && boxes.size < 20000) {
          const rect = el.getBoundingClientRect();
          if (
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < view.innerWidth &&
            rect.top < view.innerHeight
          )
            boxes.set(el, [
              rect.left,
              rect.top,
              rect.right,
              rect.bottom,
              view.getComputedStyle(el).pointerEvents !== 'none' && seen(el),
            ]);
        }
        const child =
          el.shadowRoot ||
          (['iframe', 'frame'].includes(el.localName)
            ? (el as HTMLIFrameElement).contentDocument
            : null);
        if (!child) continue;
        if (!state.observedRoots!.has(child)) {
          state.observedRoots!.add(child);
          state.observer!.observe(child, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          child.addEventListener('scroll', () => state.revision++, true);
          if (child.nodeType === Node.DOCUMENT_NODE)
            (child as Document).defaultView?.addEventListener(
              'resize',
              () => state.revision++,
            );
          state.revision++;
        }
        roots(child, depth + 1);
      }
    };
    roots(document);
    observe(state.observer!.takeRecords());
    const view = {
      document: state.document,
      revision: state.revision,
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
    };
    if (!record) return view;
    const id = `${Date.now()}-${Math.random()}`;
    state.captures = [
      ...state.captures.slice(-1),
      { id, revision: state.revision, boxes },
    ];
    return { ...view, geometry: id };
  };
  if (command === 'capture-state') return captureState(args.record !== false);
  // Settled: no change for a moment and no animation that ends on its own still running
  if (command === 'settled') {
    observe(state.observer!.takeRecords());
    const running = (doc: Document, depth = 0): boolean => {
      if (depth > 5) return false;
      try {
        if (
          doc.getAnimations().some((animation) => {
            const timing = animation.effect?.getComputedTiming();
            const target = (animation.effect as KeyframeEffect | null)?.target;
            // Circle's own pointer and its ripple are not the page's
            const root = target?.getRootNode();
            return (
              animation.playState === 'running' &&
              !!timing &&
              Number.isFinite(Number(timing.endTime)) &&
              !target?.hasAttribute('data-circle-browser-overlay') &&
              !(
                root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
                (root as ShadowRoot).host?.hasAttribute(
                  'data-circle-browser-overlay',
                )
              )
            );
          })
        )
          return true;
        for (const frame of Array.from(doc.querySelectorAll('iframe, frame'))) {
          const child = (frame as HTMLIFrameElement).contentDocument;
          if (child && running(child, depth + 1)) return true;
        }
      } catch {
        /* a frame from another site keeps its animations to itself */
      }
      return false;
    };
    return { revision: state.revision, animating: running(document) };
  }
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
  const box = (el: Element | null | undefined): el is HTMLInputElement =>
    el?.localName === 'input' &&
    ['checkbox', 'radio'].includes((el as HTMLInputElement).type);
  // A native control made see-through over a styled stand-in still takes the click
  const seeThrough = (el: Element) =>
    box(el) ||
    el.localName === 'select' ||
    (el.localName === 'input' && (el as HTMLInputElement).type === 'file');
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
        (Number(style.opacity) === 0 && !(node === el && seeThrough(el))) ||
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
    const own = clean(
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
    );
    if (own) return own.slice(0, 500);
    // A control drawn with an icon only: the name its picture or icon element gives
    for (const inner of Array.from(
      el.querySelectorAll('[aria-label], img[alt], [title]'),
    ).slice(0, 20)) {
      const text = clean(
        inner.getAttribute('aria-label') ||
          inner.getAttribute('alt') ||
          inner.getAttribute('title'),
      );
      if (text) return text.slice(0, 500);
    }
    return '';
  };
  // What an icon-only control's icon is called, from its class, sprite or file name
  const ICON =
    /^(?:el-icon|anticon|ivu-icon|layui-icon|glyphicon|fa[srbl]?|bi|mdi|ri|ti|icon|iconfont|ion|ionicon|feather|lucide|material-icons|i)-(?!(?:lg|xs|sm|[1-9]?x|fw|spin|pulse|solid|regular|light|brands|duotone|inverse|border|fixed-width|pull-[a-z]+|rotate-[a-z0-9]+|flip-[a-z]+|stack(?:-[a-z0-9]+)?)$)([a-z0-9][a-z0-9_-]*)$/i;
  const icon = (el: Element): string => {
    for (const node of [
      ...Array.from(el.querySelectorAll('i, span, svg, use, img')).slice(0, 12),
      el,
    ]) {
      const sprite = (
        node.getAttribute('href') ||
        node.getAttribute('xlink:href') ||
        ''
      ).replace(/^[^#]*#/, '');
      for (const token of [
        ...(node.getAttribute('class') ?? '').split(/\s+/),
        node.localName === 'use' ? sprite : '',
      ]) {
        const found = token.match(ICON)?.[1];
        if (found) return found.slice(0, 40);
      }
      const src =
        node.localName === 'img' ? (node.getAttribute('src') ?? '') : '';
      const named =
        node.getAttribute('data-icon') ||
        (src && !/^(?:data|blob):/i.test(src)
          ? (src
              .split(/[?#]/)[0]!
              .split('/')
              .pop()
              ?.replace(/\.[a-z0-9]+$/i, '') ?? '')
          : '');
      if (named) return named.replace(/[^\w.-]+/g, '-').slice(0, 40);
    }
    return '';
  };
  const KIT_TOGGLE =
    /^(?:(?:el|ant|ivu|van|mdc|mat|arco|semi|t|n|q|v|md|layui|custom)-)?(?:switch|checkbox|radio|toggle)$/i;
  /**
   * What the snapshot says of a control's state: what ARIA and the native control say, or
   * for a label or a styled stand-in, the see-through or hidden box it works.
   */
  const stateOf = (el: Element): string => {
    const words: string[] = [];
    const aria = (key: string) => el.getAttribute(`aria-${key}`);
    const field = el as HTMLInputElement;
    if (
      el.matches(':disabled') ||
      el.closest('[inert]') ||
      el.closest('[aria-disabled="true"]')
    )
      words.push('disabled');
    let checked = '';
    if (box(el))
      checked = field.indeterminate
        ? 'mixed'
        : field.checked
          ? 'checked'
          : 'unchecked';
    else if (['true', 'false', 'mixed'].includes(aria('checked') ?? ''))
      checked =
        aria('checked') === 'true'
          ? 'checked'
          : aria('checked') === 'false'
            ? 'unchecked'
            : 'mixed';
    else {
      const control =
        el.localName === 'label'
          ? (el as HTMLLabelElement).control
          : el.querySelectorAll('input[type=checkbox], input[type=radio]')
                .length === 1
            ? el.querySelector('input[type=checkbox], input[type=radio]')
            : null;
      if (box(control) && (el.localName === 'label' || !visible(control)))
        checked = control.indeterminate
          ? 'mixed'
          : control.checked
            ? 'checked'
            : 'unchecked';
      else {
        // A UI kit's switch or checkbox that says its state by its classes alone
        const classes = (el.getAttribute('class') ?? '').split(/\s+/);
        if (
          ['switch', 'checkbox', 'radio'].includes(
            el.getAttribute('role') ?? '',
          ) ||
          classes.some((token) => KIT_TOGGLE.test(token))
        )
          checked = classes.some((token) =>
            /(?:^|[-_])(?:checked|on)$/i.test(token),
          )
            ? 'checked'
            : 'unchecked';
      }
    }
    if (checked) words.push(checked);
    if (aria('pressed') === 'true') words.push('pressed');
    else if (aria('pressed') === 'false') words.push('not pressed');
    else if (aria('pressed') === 'mixed' && checked !== 'mixed')
      words.push('mixed');
    if (aria('selected') === 'true') words.push('selected');
    const expanded =
      el.localName === 'summary' && el.parentElement?.localName === 'details'
        ? String((el.parentElement as HTMLDetailsElement).open)
        : aria('expanded');
    if (expanded === 'true') words.push('expanded');
    else if (expanded === 'false') words.push('collapsed');
    if (field.required || aria('required') === 'true') words.push('required');
    if (aria('invalid') && aria('invalid') !== 'false') words.push('invalid');
    return words.map((word) => ` ${word}`).join('');
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
  // The part of the element its document's viewport and its scrolling or clipping
  // containers show, if any
  const shown = (
    el: Element,
  ): [left: number, top: number, right: number, bottom: number] | null => {
    const doc = el.ownerDocument;
    const view = doc.defaultView!;
    const rect = el.getBoundingClientRect();
    let [left, top, right, bottom] = [
      Math.max(0, rect.left),
      Math.max(0, rect.top),
      Math.min(view.innerWidth, rect.right),
      Math.min(view.innerHeight, rect.bottom),
    ];
    // A positioned element is clipped by its containing block and what clips that, not by
    // the containers in between
    let mode = view.getComputedStyle(el).position;
    for (
      let up = parent(el);
      up && up.ownerDocument === doc && mode !== 'fixed';
      up = parent(up)
    ) {
      const style = view.getComputedStyle(up);
      if (
        mode === 'absolute' &&
        style.position === 'static' &&
        style.transform === 'none'
      )
        continue;
      // The root's overflow, and the body's when the root leaves it visible, is the
      // viewport's, which is clipped to already
      const viewport =
        up === doc.documentElement ||
        (up === doc.body &&
          view.getComputedStyle(doc.documentElement).overflow === 'visible');
      if (
        !viewport &&
        (style.overflowX !== 'visible' || style.overflowY !== 'visible')
      ) {
        const clip = up.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      mode = style.position;
    }
    return right - left >= 1 && bottom - top >= 1
      ? [left, top, right, bottom]
      : null;
  };
  // Points a click on the element may land on, in its document's viewport: the middle of
  // each of its line boxes first (a link that wraps has a gap at the middle of its whole
  // box), then the middle of the whole box, then points around it
  const spots = (el: Element, most = 13): [number, number][] => {
    const area = shown(el);
    if (!area) return [];
    const [left, top, right, bottom] = area;
    const list: [number, number][] = [];
    const add = (x: number, y: number) => {
      if (
        list.length < most &&
        x >= left &&
        x < right &&
        y >= top &&
        y < bottom &&
        !list.some(([a, b]) => Math.abs(a - x) < 1 && Math.abs(b - y) < 1)
      )
        list.push([x, y]);
    };
    for (const line of Array.from(el.getClientRects()))
      add(
        (Math.max(left, line.left) + Math.min(right, line.right)) / 2,
        (Math.max(top, line.top) + Math.min(bottom, line.bottom)) / 2,
      );
    add((left + right) / 2, (top + bottom) / 2);
    for (const [fx, fy] of [
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
      [0.25, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
      [0.75, 0.25],
      [0.1, 0.5],
      [0.9, 0.5],
    ] as const)
      add(left + (right - left) * fx, top + (bottom - top) * fy);
    return list;
  };
  // Whether a click that lands on `found` acts on the element: inside it, or for a
  // checkbox or radio button, on its label (not on a link or another control there)
  const takes = (el: Element, found: Element | null): boolean => {
    if (!found) return false;
    if (composedContains(el, found)) return true;
    if (!box(el)) return false;
    const inner = found.closest(
      'a[href], button, input, select, textarea, summary, [role=button], [role=link]',
    );
    return Array.from((el as HTMLInputElement).labels ?? []).some(
      (label) =>
        composedContains(label, found) &&
        (!inner || !composedContains(label, inner)),
    );
  };
  // What lies over the whole viewport, when a dialog, drawer or mask covers the page: an
  // element outside it is under it, also one scrolled out of view
  let cover: Element | null | undefined;
  const coverLayer = (): Element | null => {
    if (cover !== undefined) return cover;
    cover = null;
    try {
      // A modal <dialog> makes the rest of the page inert, its backdrop over it
      const modal = document.querySelector('dialog:modal');
      if (modal) return (cover = modal);
    } catch {
      /* a browser without :modal */
    }
    const width = innerWidth,
      height = innerHeight;
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.1],
      [0.9, 0.1],
      [0.1, 0.9],
      [0.9, 0.9],
    ] as const) {
      // From the top down to the first element of the page's own content
      for (const node of document.elementsFromPoint(width * fx, height * fy)) {
        if (node === document.documentElement || node === document.body) break;
        let fixed: Element | null = null;
        for (
          let up: Element | null = node;
          up && up.ownerDocument === document;
          up = parent(up)
        )
          if (getComputedStyle(up).position === 'fixed') fixed = up;
        if (!fixed) break;
        const rect = fixed.getBoundingClientRect();
        if (
          rect.left <= 1 &&
          rect.top <= 1 &&
          rect.right >= width - 1 &&
          rect.bottom >= height - 1
        )
          return (cover = fixed);
      }
    }
    return cover;
  };
  const DIALOG =
    'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';
  // The dialog or drawer a node is part of, or that lies in the same layer over the page: it
  // stays until it is answered or closed
  const modalOf = (node: Element | null): Element | null => {
    if (!node) return null;
    const own = node.closest(DIALOG);
    if (own) return own;
    const layer = node.ownerDocument === document ? coverLayer() : null;
    if (!layer || !composedContains(layer, node)) return null;
    // A mask of its own beside the dialog or drawer it is for
    return layer.matches(DIALOG)
      ? layer
      : (layer.querySelector(DIALOG) ??
          Array.from(document.querySelectorAll(DIALOG)).find((dialog) =>
            visible(dialog),
          ) ??
          null);
  };
  const dialogName = (dialog: Element) => {
    const root = dialog.getRootNode() as Document | ShadowRoot;
    return clean(
      dialog.getAttribute('aria-label') ||
        dialog
          .getAttribute('aria-labelledby')
          ?.split(/\s+/)
          .map((id) => root.getElementById?.(id)?.textContent ?? '')
          .join(' ') ||
        dialog.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"]')
          ?.textContent,
    ).slice(0, 80);
  };
  // Whether something on top would take a click meant for the element
  const covered = (el: Element): boolean => {
    const points = spots(el, 5);
    if (points.length)
      return !points.some(([x, y]) => takes(el, hit(el.ownerDocument, x, y)));
    // Out of view: the page's own content is under what covers the viewport; what is fixed
    // (a drawer, a header) is not judged from here
    const layer = el.ownerDocument === document ? coverLayer() : null;
    if (!layer || composedContains(layer, el)) return false;
    for (
      let up: Element | null = el;
      up && up.ownerDocument === document;
      up = parent(up)
    )
      if (getComputedStyle(up).position === 'fixed') return false;
    return true;
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
    const fresh = state.snapshots++ > 0;
    // Elements that got their ref in this snapshot
    const added = new WeakSet<Element>();
    const assigned: Element[] = [];
    type Out = {
      lines: string[];
      length: number;
      limit: number;
      truncated: boolean;
    };
    let out: Out = { lines: [], length: 0, limit: 30000, truncated: false };
    let stop = deadline;
    const add = (line: string) => {
      const remaining = out.limit - out.length;
      if (remaining <= 0) {
        out.truncated = true;
        return;
      }
      if (line.length + 1 > remaining) out.truncated = true;
      const text = line.slice(0, Math.max(0, remaining - 1));
      out.lines.push(text);
      out.length += text.length + 1;
    };
    // What may lie on top of the page (dialogs, drawers, menus, popups a page puts at the
    // end of its body): a long page must not leave them out
    const all = document.getElementsByTagName('*').length;
    const layers = new Set<Element>();
    if (document.body) {
      const found = [
        ...Array.from(
          document.querySelectorAll(
            'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
          ),
        ).filter((el) => visible(el)),
        ...Array.from(document.body.children).filter(
          (el) =>
            !['script', 'style', 'noscript', 'template'].includes(
              el.localName,
            ) &&
            ['fixed', 'absolute'].includes(getComputedStyle(el).position) &&
            !hidden(el),
        ),
        ...[coverLayer()].filter((el): el is Element => !!el),
      ];
      for (const el of found)
        if (
          // The app's own frame is the page, not something on top of it
          el.getElementsByTagName('*').length <= all / 2 &&
          !found.some((other) => other !== el && composedContains(other, el))
        )
          layers.add(el);
    }
    const finished = new WeakSet<Element>();
    let skip = new Set<Element>();
    const walk = (
      node: Node,
      indent = '',
      suppressText = false,
      inAction = false,
    ) => {
      if (
        ++visited > 15000 ||
        performance.now() > stop ||
        out.length >= out.limit
      ) {
        out.truncated = true;
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
        skip.has(el) ||
        ['script', 'style', 'noscript', 'template'].includes(el.localName) ||
        hidden(el)
      )
        return;
      const isVisible = visible(el);
      const isAction =
        isVisible && actionable(el) && (!inAction || nestedAction(el));
      let ref = '';
      if (isAction) {
        ref = state.ids.get(el) ?? '';
        if (!ref) {
          ref = `e${++state.next}`;
          state.ids.set(el, ref);
          assigned.push(el);
          if (fresh) added.add(el);
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
        const label = name(el);
        const drawn = label ? '' : icon(el);
        const under = covered(el);
        // On a certificate warning, what its advanced button and its link to proceed are,
        // in any language: a replayed script's proceed step finds them so
        const warning = warningAction(el);
        add(
          `${indent}[${ref}] ${role(el)} ${JSON.stringify(label)}${drawn ? ` icon=${drawn}` : ''}${content}${stateOf(el)}${added.has(el) ? ' [new]' : ''}${under ? ' [covered]' : ''}${warning === 'advanced' || warning === 'proceed' ? ` [warning: ${warning}]` : ''}`,
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
        const start = out.lines.length;
        const before = out.length;
        for (const child of Array.from(el.childNodes))
          walk(child, '', false, inAction);
        const cells = out.lines.splice(start);
        out.length = before;
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
      if (layers.has(el) && !out.truncated) finished.add(el);
    };
    const page = document.body || document.documentElement;
    state.refs.clear();
    walk(page);
    let lines = out.lines;
    let truncated = out.truncated;
    // Cut short before what lies on top was read: that first, then the page with the room left
    const pending = [...layers].filter((el) => !finished.has(el));
    if (truncated && pending.length) {
      state.refs.clear();
      visited = 0;
      stop = performance.now() + 1000;
      out = { lines: [], length: 0, limit: 15000, truncated: false };
      for (const layer of pending) walk(layer);
      const top = out;
      skip = new Set(pending);
      visited = 0;
      out = {
        lines: [],
        length: 0,
        limit: 30000 - top.length - 100,
        truncated: false,
      };
      walk(page);
      lines = [
        ...out.lines,
        '… the rest of the page is left out; what lies on top of it follows',
        ...top.lines,
      ];
      truncated = true;
      // An element the first reading gave a ref and this one left out is new when it shows
      const kept = new Set(state.refs.values());
      for (const el of assigned) if (!kept.has(el)) state.ids.delete(el);
    }
    return lines.join('\n') + (truncated ? '\n… snapshot truncated' : '');
  }
  if (command === 'point') {
    const capture = (args.capture ?? {}) as Record<string, unknown>;
    const stale = (why = '') =>
      Error(`the screenshot is stale${why}; take a new browser_screenshot`);
    // Another document, viewport or scroll position: nothing is where the picture shows it
    const current: Record<string, unknown> = captureState();
    if (
      ['document', 'width', 'height', 'scrollX', 'scrollY'].some(
        (key) => current[key] !== capture[key],
      )
    )
      throw stale();
    const recorded = state.captures.find(
      (entry) => entry.id === capture.geometry,
    );
    if (!recorded) throw stale();
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
    let doc = document,
      localX = x,
      localY = y;
    // The point in each document the click goes through, and the frames on the way
    const at = new Map<Document, [number, number]>([[document, [x, y]]]);
    const frames: Element[] = [];
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
      frames.push(frame);
      doc = child;
      at.set(doc, [localX, localY]);
      el = hit(doc, localX, localY);
    }
    if (!el || hidden(el))
      throw Error('there is no visible element at these coordinates');
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
    // What the screenshot showed at the point is still there as it was: the element hit and
    // the control it is part of, in place and unchanged, and what lay over the point not
    // gone. Changes elsewhere on the page (a list that refreshes, a tooltip, a clock) do not
    // matter. Once the pointer is there (`hover`), a hover may restyle or move the target;
    // a change of its content or of what it does still counts.
    const since = recorded.revision;
    const changes = args.hover ? state.altered : state.touched;
    const changed = (node: Node) => (changes.get(node) ?? 0) > since;
    const moved = (node: Element) => {
      const was = recorded.boxes.get(node);
      if (!was) return true;
      const now = node.getBoundingClientRect();
      return (
        Math.abs(now.left - was[0]) > 1 ||
        Math.abs(now.top - was[1]) > 1 ||
        Math.abs(now.right - was[2]) > 1 ||
        Math.abs(now.bottom - was[3]) > 1
      );
    };
    const chain: Element[] = [];
    for (let node: Element | null = el; node; node = parent(node)) {
      chain.push(node);
      if (node === target) break;
    }
    if (
      [...chain, ...frames].some((node) =>
        args.hover ? !recorded.boxes.has(node) : moved(node),
      )
    )
      throw stale(': what is at these coordinates moved or is new');
    // Inside the control (or, for a large one, the element hit), any change since
    const small = (node: Element) =>
      node.getElementsByTagName('*').length <= 1000;
    const region = small(target) ? target : small(el) ? el : null;
    let count = 0;
    const changedIn = (node: Element | ShadowRoot): boolean => {
      if (++count > 3000 || changed(node)) return true;
      const shadow = (node as Element).shadowRoot;
      if (shadow && changedIn(shadow)) return true;
      return Array.from(node.children).some(changedIn);
    };
    if (chain.some(changed) || (region && changedIn(region)))
      throw stale(': what is at these coordinates changed');
    // What could be seen and clicked at the point then and is not on the way to the element
    // now (a mask, a message, a menu): gone, moved, hidden or changed, the click would reach
    // what it covered
    const onPath = (node: Element) =>
      composedContains(node, el) ||
      frames.some((frame) => composedContains(node, frame));
    for (const [node, was] of recorded.boxes) {
      const point = at.get(node.ownerDocument);
      if (
        !was[4] ||
        !point ||
        point[0] < was[0] ||
        point[0] >= was[2] ||
        point[1] < was[1] ||
        point[1] >= was[3] ||
        onPath(node)
      )
        continue;
      let gone = !node.isConnected || moved(node) || !seen(node);
      for (
        let up: Element | null = node;
        up && !gone && !onPath(up);
        up = parent(up)
      )
        gone = changed(up);
      if (gone) throw stale(': what lay over these coordinates changed');
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
    const points = spots(el);
    const area = shown(el);
    if (!points.length || !area)
      throw Error('the element is outside the viewport');
    const describe = (obstruction: Element | null) =>
      obstruction
        ? `${role(obstruction)} ${JSON.stringify(name(obstruction).slice(0, 80))}`
        : 'another element';
    // The first point where a click reaches the element, through the frames it is in
    let blocked = '';
    for (const [left, top] of points) {
      const obstruction = hit(el.ownerDocument, left, top);
      if (!takes(el, obstruction)) {
        if (!blocked) {
          const modal = modalOf(obstruction);
          blocked = `the element is covered by ${describe(obstruction)}${modal ? ` of dialog ${JSON.stringify(dialogName(modal))}` : ''}`;
        }
        continue;
      }
      let x = left,
        y = top,
        width = area[2] - area[0],
        height = area[3] - area[1];
      let through = true;
      for (const frame of frames) {
        const bounds = frame.getBoundingClientRect();
        const scaleX = bounds.width / (frame.offsetWidth || bounds.width);
        const scaleY = bounds.height / (frame.offsetHeight || bounds.height);
        x = bounds.left + (frame.clientLeft + x) * scaleX;
        y = bounds.top + (frame.clientTop + y) * scaleY;
        width *= scaleX;
        height *= scaleY;
        const obstruction = hit(frame.ownerDocument, x, y);
        if (!composedContains(frame, obstruction)) {
          blocked ||= `the frame is covered by ${describe(obstruction)}`;
          through = false;
          break;
        }
      }
      if (through)
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
    throw Error(blocked);
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

/** A page command run in a tab, the way its browser runs one. */
export type PageRun = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
const COVERED = /^the (?:element|frame) is covered by /;
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });
/** How long an action waits for what covers its element to go. */
export const COVER_WAIT = 3000;

/**
 * Where an action's element takes the input (`prepare`). While something covers it (a
 * loading mask, a message, an animation) it is asked again until `wait` runs out; a dialog
 * or drawer stays until it is answered, so it is said once the page has stopped changing.
 * `stopped` ends the wait (a dialog the page opened, a closed tab); `busy` is the page's
 * network still loading.
 */
export async function reachElement<T>(
  run: PageRun,
  args: Record<string, unknown>,
  page: { stopped: () => boolean; busy: () => boolean },
  signal: AbortSignal,
  wait = COVER_WAIT,
): Promise<T> {
  const started = Date.now();
  let quiet: { revision: number; since: number } | undefined;
  for (;;) {
    try {
      return await run<T>('prepare', args);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!COVERED.test(text) || page.stopped()) throw error;
      const waited = Date.now() - started;
      if (waited >= wait)
        throw Error(
          `${text}, still after ${Math.round(waited / 100) / 10} s; take a new browser_snapshot`,
        );
      if (/ of dialog "/.test(text)) {
        const now = await run<{ revision: number; animating: boolean }>(
          'settled',
        ).catch(() => {
          // A page that answers nothing now (a dialog of its own, a closed tab)
          throw error;
        });
        if (
          !quiet ||
          quiet.revision !== now.revision ||
          now.animating ||
          page.busy()
        )
          quiet = { revision: now.revision, since: Date.now() };
        else if (Date.now() - quiet.since >= 500)
          throw Error(
            `${text}: close the dialog or act in it first; take a new browser_snapshot`,
          );
      }
      await pause(150, signal);
    }
  }
}

/**
 * After an action, until the page stops changing: no change to its document for a moment
 * and no transition or animation that ends still running (a drawer sliding in, a mask
 * fading), for at most `most`.
 */
export async function settlePage(
  run: PageRun,
  page: { stopped: () => boolean; busy: () => boolean },
  signal: AbortSignal,
  most = 1500,
): Promise<void> {
  const end = Date.now() + most;
  let last: number | undefined;
  let since = Date.now();
  while (Date.now() < end) {
    if (page.stopped()) return;
    let now: { revision: number; animating: boolean };
    try {
      now = await run('settled');
    } catch {
      // A page that answers nothing now (a dialog, a document on its way) is not waited on
      signal.throwIfAborted();
      return;
    }
    if (now.revision !== last || page.busy()) {
      last = now.revision;
      since = Date.now();
    } else if (!now.animating && Date.now() - since >= 200) return;
    await pause(80, signal);
  }
}
