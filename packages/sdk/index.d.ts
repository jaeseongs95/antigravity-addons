export type SurfaceKind = 'desktop' | 'remote-web';
export type LayoutMode = 'desktop' | 'compact' | 'mobile';
export type TrustLevel = 'trusted' | 'restricted';

export interface UiCondition {
  field?: string;
  eq?: unknown;
  neq?: unknown;
  in?: unknown[];
  truthy?: boolean;
  all?: UiCondition[];
  any?: UiCondition[];
}

export type UiNodeType =
  | 'stack'
  | 'row'
  | 'section'
  | 'heading'
  | 'text'
  | 'badge'
  | 'divider'
  | 'alert'
  | 'button'
  | 'toggle'
  | 'input'
  | 'textarea'
  | 'select'
  | 'slider'
  | 'progress'
  | 'list';

export interface UiNode {
  type: UiNodeType;
  id?: string;
  title?: string;
  text?: string;
  label?: string;
  field?: string;
  value?: unknown;
  placeholder?: string;
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
  tone?: 'default' | 'muted';
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  inputType?: 'text' | 'password' | 'number' | 'url';
  rows?: number;
  min?: number;
  max?: number;
  step?: number;
  actionId?: string;
  submitActionId?: string;
  payload?: unknown;
  options?: Array<string | { value: string; label?: string }>;
  items?: Array<string | { id?: string; label?: string; text?: string; actionId?: string; actionLabel?: string; payload?: unknown }>;
  disabled?: boolean;
  visibleWhen?: UiCondition;
  disabledWhen?: UiCondition;
  children?: UiNode[];
}

export interface PlacementSpec {
  zone?: 'anchor' | 'surface-center' | 'corner' | 'sheet' | 'drawer';
  anchorEl?: Element | null;
  anchorKey?: string;
  prefer?: 'top' | 'bottom' | 'left' | 'right' | 'top-start' | 'top-center' | 'top-end' | 'bottom-start' | 'bottom-center' | 'bottom-end';
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  side?: 'left' | 'right';
  surface?: string;
  offset?: number;
  margin?: number;
  width?: number;
  height?: number;
  maxWidth?: number;
  maxHeight?: number;
  mobileBreakpointPx?: number;
  disableMobileSheet?: boolean;
}

export interface OverlayOptions {
  title?: string;
  placement?: PlacementSpec;
  tree?: UiNode;
  state?: Record<string, unknown>;
  closable?: boolean;
  closeOnOutsideClick?: boolean;
  onChange?: (ev: { field?: string; value: unknown; state: Record<string, unknown> }) => void;
  onAction?: (ev: { actionId: string; payload?: unknown; state: Record<string, unknown> }) => void;
  onClose?: () => void;
}

export interface OverlayHandle {
  readonly kind: 'popup' | 'modal' | 'panel';
  readonly element: Element;
  readonly bodyEl: Element | null;
  readonly attributionBadge: Element;
  getPlacement(): Record<string, unknown> | null;
  reposition(): Record<string, unknown> | null;
  update(nextTree?: UiNode, nextState?: Record<string, unknown>): void;
  getState(): Record<string, unknown> | null;
  getElementById(nodeId: string): Element | null;
  close(): boolean;
}

export interface StatusItemClickEvent {
  readonly pluginId: string;
  readonly itemId: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly anchorEl: Element | null;
}

export interface StatusItemSpec {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  badge?: string | null;
  align?: 'left' | 'right';
  priority?: number;
  onClick?: (ev: StatusItemClickEvent) => void;
}

export interface StatusItemHandle {
  readonly id: string;
  update(patch: Partial<Omit<StatusItemSpec, 'id' | 'onClick'>>): void;
  dispose(): void;
}

export interface SettingsPageSpec {
  id: string;
  title: string;
  order?: number;
  width?: number;
  schema?: UiNode;
  state?: Record<string, unknown>;
  getSchema?: () => UiNode;
  getState?: () => Record<string, unknown>;
  onChange?: (ev: { field?: string; value: unknown; state: Record<string, unknown> }) => void;
  onAction?: (ev: { actionId: string; payload?: unknown; state: Record<string, unknown> }) => void;
  render?: (canvasRoot: Element, handle: OverlayHandle) => void;
  onClose?: () => void;
}

export interface NetFetchResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  url?: string;
  channel?: 'https' | 'localLoopback';
  reason?: string;
}

export interface AddonContextV3 {
  readonly apiVersion: 3;
  readonly meta: {
    readonly pluginId: string;
    readonly displayName: string;
    readonly version: string;
    readonly trustLevel: TrustLevel;
    readonly sourceSchemaVersion: number;
  };
  readonly env: {
    readonly surface: SurfaceKind;
    readonly layoutMode: LayoutMode;
    readonly capabilities: {
      readonly hasLocalLoopback: boolean;
      readonly hasNetHttps: boolean;
      readonly hasConfigBridge: boolean;
      readonly hasSettingsBridge: boolean;
      readonly hasDocumentTransform: boolean;
    };
  };
  readonly theme: {
    getMode(): 'dark' | 'light';
    getTokens(): Readonly<Record<string, string>>;
    getTokenCss(): string;
    onDidChange(cb: (snap: { mode: 'dark' | 'light'; tokens: Readonly<Record<string, string>> }) => void): () => void;
  };
  readonly i18n: {
    getLocale(): string;
    t(key: string, dictOrParams?: Record<string, unknown>, params?: Record<string, unknown>): string;
  };
  readonly ui: {
    showToast(opts: string | { message: string; title?: string; variant?: 'info' | 'success' | 'warning' | 'error'; durationMs?: number; action?: { label: string; onClick: () => void } }): { readonly id: string; dismiss(): void };
    confirm(opts: string | { title?: string; message: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean>;
    prompt(opts: string | { title?: string; message: string; defaultValue?: string; placeholder?: string; inputType?: 'text' | 'password'; confirmLabel?: string; cancelLabel?: string }): Promise<string | null>;
    registerCommand(commandId: string, spec: { label?: string; run: (...args: unknown[]) => unknown }): { unregister(): void; dispose(): void };
    listCommands(): Array<{ pluginId: string; actionId: string; label: string }>;
    invokeCommand(targetPluginId: string, commandId: string, ...args: unknown[]): unknown;
    registerStatusItem(spec: StatusItemSpec): StatusItemHandle;
    registerSettingsPage(spec: SettingsPageSpec): { readonly id: string; open(): OverlayHandle | null; update(nextSchema?: UiNode, nextState?: Record<string, unknown>): void; dispose(): void };
    openPopup(opts: OverlayOptions): OverlayHandle;
    openModal(opts: OverlayOptions): OverlayHandle;
    openPanel(opts: OverlayOptions): OverlayHandle;
    mountCanvas(slotId: string, opts?: Record<string, unknown>): Record<string, unknown>;
    createStyleElementSafe(cssText: string): HTMLStyleElement;
    injectStyle(styleId: string, cssText: string, opts?: Record<string, unknown>): unknown;
    removeStyle(styleId: string): boolean;
    getSurfaceBounds(surfaceIdOrOpts?: string | { surface?: string; anchorEl?: Element | null }): Record<string, unknown>;
    getActiveSurface(): Record<string, unknown>;
    listSurfaces(): readonly string[];
  };
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
    onDidChange(cb: (ev: { key: string; oldValue: unknown; newValue: unknown }) => void): () => void;
  };
  readonly events: {
    on(topic: string, handler: (payload: unknown, meta: { topic: string; sourcePluginId: string }) => void): () => void;
    once(topic: string, handler: (payload: unknown, meta: { topic: string; sourcePluginId: string }) => void): () => void;
    emit(topic: string, payload?: unknown): number;
  };
  readonly services: {
    provide(serviceName: string, impl: Record<string, (...args: unknown[]) => unknown>, opts?: { allowedCallers?: string[] }): { readonly name: string; dispose(): void };
    has(serviceName: string): boolean;
    list(): ReadonlyArray<{ readonly name: string; readonly providerPluginId: string; readonly methods: readonly string[] }>;
    call<T = unknown>(serviceName: string, methodName: string, ...args: unknown[]): T;
  };
  readonly lifecycle: {
    readonly signal: AbortSignal | null;
    onDispose(fn: () => void): void;
    addManagedListener(target: EventTarget, type: string, listener: (ev: Event) => void, opts?: boolean | AddEventListenerOptions): () => void;
    runSafe<T>(fn: () => T): T | undefined;
    dispose(): void;
  };
  readonly net?: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<NetFetchResponse>;
  };
  readonly dom?: {
    observeRegion(selector: string, callback: (records: unknown[]) => void, opts?: Record<string, unknown>): { disconnect(): void };
    isElementInsideIgnored(nodeOrEvent: unknown, opts?: { ignoreElements?: Element[] }): boolean;
    mountSlot(slotId: string, opts?: Record<string, unknown>): Record<string, unknown>;
    unmountSlot(slotId: string): boolean;
  };
  readonly configBridge?: {
    readonly scopes: ReadonlyArray<{ readonly scopeId: string; readonly access: 'ro' | 'rw'; readonly maxBytes: number }>;
    read(scopeId: string): Promise<Record<string, unknown>>;
    write(scopeId: string, nextDataOrRawJson: Record<string, unknown> | string, opts?: { expectedSha256?: string | null }): Promise<Record<string, unknown>>;
  };
}

export interface AddonManifestV3 {
  schemaVersion: 3;
  apiVersion?: 3;
  pluginId: string;
  displayName: string;
  description?: string;
  version: string;
  trustLevel?: TrustLevel;
  capabilities: Array<'renderer' | 'mainHook'>;
  entry: {
    rendererScript?: string | null;
    mainHookScript?: string | null;
  };
  permissions?: {
    ui?: Record<string, boolean>;
    storage?: { maxBytes?: number; namespace?: string };
    events?: { subscribe?: string[]; emit?: string[] };
    services?: {
      provide?: Array<{ name: string; allowedCallers?: string[] }>;
      consume?: string[];
    };
    net?: {
      httpsHosts?: string[];
      localLoopback?: Array<number | string>;
    };
    dom?: {
      documentTransform?: boolean;
      anchors?: string[];
    };
    configBridge?: {
      scopes: Array<{ scopeId: string; access: 'ro' | 'rw'; maxBytes?: number }>;
    };
  };
  uiSlots?: Array<Record<string, unknown>>;
  isolation?: Record<string, unknown>;
  loadOrder?: number;
}

export interface AddonDefinition {
  manifest?: AddonManifestV3;
  setup(ctx: AddonContextV3): void | Promise<void>;
}

export function defineAddon(def: AddonDefinition): AddonDefinition;
export function h(type: UiNodeType, props?: Omit<UiNode, 'type' | 'children'>, children?: UiNode[]): UiNode;

export interface TestHostOptions {
  surface?: SurfaceKind;
  viewport?: { width: number; height: number };
  locale?: string;
  themeMode?: 'dark' | 'light';
  netHandler?: (pluginId: string, url: string, init?: Record<string, unknown>) => Promise<NetFetchResponse> | NetFetchResponse;
  configScopes?: Record<string, { data: Record<string, unknown>; sha256?: string }>;
}

export interface TestHostHandle {
  readonly surface: SurfaceKind;
  readonly kernel: Record<string, unknown>;
  readonly doc: Record<string, unknown>;
  readonly win: Record<string, unknown>;
  mountPlugin(manifest: AddonManifestV3, setupFn: (ctx: AddonContextV3) => unknown): Promise<AddonContextV3>;
  disposePlugin(pluginId: string): boolean;
  setViewport(width: number, height: number): void;
  getStatusItems(): readonly Record<string, unknown>[];
  getSettingsPages(): readonly Record<string, unknown>[];
}

export function createTestHost(opts?: TestHostOptions): TestHostHandle;
