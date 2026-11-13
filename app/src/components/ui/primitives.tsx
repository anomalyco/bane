import { Children, Fragment, cloneElement, createContext, forwardRef, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, LoaderCircle, MoreHorizontal, Search, X } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';
import { label as formatLabel } from '../../lib/format';
import { permissionCodes } from '../../data/types';
import { PrivateAddress } from '../PrivateAddress';
import { TOUCH, matches, usePhone, useTouch } from '../../lib/media';
import { SkeletonText, PaginationSkeleton, ControlSkeleton } from './skeleton';
import { Sheet, SheetOpenEffects, useSheetDrag } from './sheet';
import { isDuplicateSubmission } from '../../lib/single-flight';

const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, disabled, className, children, type = 'button', ...props }, ref) {
  return <button data-component="Button" {...props} ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, className)}>{loading && <LoaderCircle className="ui-spinner" size={14} aria-hidden="true" />}{children}</button>;
});
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton({ label, className, variant = 'ghost', loading, children, ...props }, ref) {
  // A caller's title (for example why the action is unavailable) wins over the label.
  return <Button data-component="IconButton" {...props} ref={ref} variant={variant} loading={loading} aria-label={label} title={props.title ?? label} className={cx('ui-icon-button', className)}>{loading ? null : children}</Button>;
});
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input data-component="Input" {...props} ref={ref} className={cx('ui-input', className)} />;
});
// A field for a secret or a write-only capability (an endpoint URL with its token, a header value): marked so staff UI
// notes refuse it and black it out (features/ui-notes), and kept out of autofill.
export const SecretInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function SecretInput(props, ref) {
  return <Input data-sensitive autoComplete="off" spellCheck={false} {...props} ref={ref} />;
});
// A list's search box: the magnifier, type=search and the shared width (.search-box). Props go to the input.
export const SearchField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function SearchField({ className, ...props }, ref) {
  return <div data-component="SearchField" className={cx('search-box', className)}><Search size={16} aria-hidden="true" /><Input {...props} ref={ref} type="search" /></div>;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea data-component="Textarea" {...props} ref={ref} className={cx('ui-input', 'ui-textarea', className)} />;
});
export function Field({ label, htmlFor, error, hint, children }: { label: ReactNode; htmlFor?: string; error?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const generatedId = useId();
  const onlyChild = Children.count(children) === 1 && isValidElement(children) && children.type !== Fragment && !(typeof children.type === 'string' && ['div', 'span', 'section'].includes(children.type)) ? children as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }> : null;
  const id = htmlFor ?? onlyChild?.props.id ?? generatedId;
  const descriptionId = `${id}-description`;
  return <div data-component="Field" className="ui-field"><label className="ui-field__label" htmlFor={id}>{label}</label>{onlyChild ? cloneElement(onlyChild, { id, 'aria-invalid': error ? true : onlyChild.props['aria-invalid'], 'aria-describedby': [onlyChild.props['aria-describedby'], error || hint ? descriptionId : null].filter(Boolean).join(' ') || undefined }) : children}{(error || hint) && <div id={descriptionId} className={cx('ui-field__hint', Boolean(error) && 'ui-field__error')} role={error ? 'alert' : undefined}>{error || hint}</div>}</div>;
}
// A label may be any node (the menu and the trigger render it); `text` is its plain form for the phone's native picker, which can't
// show a node. `mask`: string labels are email addresses, shown through PrivateAddress (blurred until hovered or focused, like every
// address); the native picker on a touch screen can't blur them.
export type SelectOption = { value: string; label: ReactNode; text?: string; disabled?: boolean };
export type SelectProps = { value: string; onValueChange: (value: string) => void; options: SelectOption[]; mask?: boolean; placeholder?: string; id?: string; name?: string; disabled?: boolean; required?: boolean; 'aria-label'?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; className?: string };
function SheetSelect({ value, onValueChange, options, shown, placeholder, id, name, disabled, className, aria }: { value: string; onValueChange: (value: string) => void; options: SelectOption[]; shown: (option: SelectOption) => ReactNode; placeholder: string; id?: string; name?: string; disabled?: boolean; className?: string; aria: Pick<SelectProps, 'aria-label' | 'aria-describedby' | 'aria-invalid'> }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find(option => option.value === value);
  return <>
    <button ref={trigger} type="button" data-component="Select" {...aria} id={id} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} className={cx('ui-input', 'ui-select-trigger', className)} data-placeholder={current ? undefined : ''} onClick={() => setOpen(true)}><span>{current ? shown(current) : placeholder}</span><span aria-hidden="true"><ChevronDown size={14} /></span></button>
    {name && <input type="hidden" name={name} value={value} />}
    <Sheet open={open} onOpenChange={setOpen} title={aria['aria-label'] ?? placeholder} className="ui-action-sheet" returnFocus={trigger}>
      <div className="ui-action-sheet__items" role="listbox" aria-label={aria['aria-label'] ?? placeholder}>{options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className="ui-action-sheet__item" onClick={() => { setOpen(false); onValueChange(option.value); }}><span className="ui-action-sheet__label">{shown(option)}</span>{option.value === value && <Check size={14} aria-hidden="true" />}</button>)}</div>
      <button type="button" className="ui-action-sheet__item ui-action-sheet__cancel" onClick={() => setOpen(false)}>Cancel</button>
    </Sheet>
  </>;
}
const optionText = (option: SelectOption) => option.text ?? (typeof option.label === 'string' ? option.label : option.value);
export function Select({ value, onValueChange, options, mask = false, placeholder = 'Select…', id, name, disabled, required, className, ...aria }: SelectProps) {
  const shown = (option: SelectOption) => mask && typeof option.label === 'string' ? <PrivateAddress value={option.label} /> : option.label;
  const emptyValue = useId();
  const hasEmptyOption = options.some(option => option.value === '');
  const touch = useTouch();
  // Touch screens get the platform's own picker (the iOS wheel, Android's list): bigger targets, no zoom, no popover. Options a
  // native list can't draw (addresses to blur, rich labels) get a bottom sheet of the same rows instead.
  if (touch && (mask || options.some(option => typeof option.label !== 'string'))) return <SheetSelect value={value} onValueChange={onValueChange} options={options} shown={shown} placeholder={placeholder} id={id} name={name} disabled={disabled} className={className} aria={aria} />;
  if (touch) {
    const known = options.some(option => option.value === value);
    return <select data-component="Select" {...aria} id={id} name={name} disabled={disabled} required={required} className={cx('ui-input', 'ui-select-trigger', 'ui-native-select', className)} value={known ? value : ''} data-placeholder={known ? undefined : ''} onChange={event => onValueChange(event.target.value)}>{!known && <option value="" disabled hidden>{placeholder}</option>}{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{optionText(option)}</option>)}</select>;
  }
  return <SelectPrimitive.Root value={value === '' && hasEmptyOption ? emptyValue : value} onValueChange={next => onValueChange(next === emptyValue ? '' : next)} name={name} disabled={disabled} required={required}><SelectPrimitive.Trigger data-component="Select" {...aria} id={id} className={cx('ui-input', 'ui-select-trigger', className)} onPointerEnter={event => { const label = event.currentTarget.firstElementChild, selected = options.find(option => option.value === value); event.currentTarget.title = !mask && label && selected && label.scrollWidth > label.clientWidth ? optionText(selected) : ''; }}><SelectPrimitive.Value placeholder={placeholder} /><SelectPrimitive.Icon><ChevronDown size={14} aria-hidden="true" /></SelectPrimitive.Icon></SelectPrimitive.Trigger><SelectPrimitive.Portal><SelectPrimitive.Content className="ui-popover ui-select-content" position="popper" sideOffset={4}><SelectPrimitive.ScrollUpButton className="ui-select-scroll"><ChevronDown size={14} className="ui-rotate" /></SelectPrimitive.ScrollUpButton><SelectPrimitive.Viewport>{options.map(option => <SelectPrimitive.Item key={option.value} value={option.value === '' ? emptyValue : option.value} disabled={option.disabled} className="ui-select-item"><SelectPrimitive.ItemText>{shown(option)}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>)}</SelectPrimitive.Viewport><SelectPrimitive.ScrollDownButton className="ui-select-scroll"><ChevronDown size={14} /></SelectPrimitive.ScrollDownButton></SelectPrimitive.Content></SelectPrimitive.Portal></SelectPrimitive.Root>;
}
type CheckProps = { checked: boolean; onCheckedChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean; id?: string; name?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };
export function Checkbox({ checked, onCheckedChange, label, disabled, id: suppliedId, ...props }: CheckProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <div data-component="Checkbox" className="ui-check-field"><CheckboxPrimitive.Root {...props} id={id} checked={checked} onCheckedChange={value => onCheckedChange(value === true)} disabled={disabled} className="ui-checkbox"><CheckboxPrimitive.Indicator><Check size={12} strokeWidth={2} /></CheckboxPrimitive.Indicator></CheckboxPrimitive.Root><label htmlFor={id}>{label}</label></div>;
}
export function Switch({ checked, onCheckedChange, label, disabled, id: suppliedId, ...props }: CheckProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <div data-component="Switch" className="ui-check-field"><SwitchPrimitive.Root {...props} id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="ui-switch"><SwitchPrimitive.Thumb className="ui-switch__thumb" /></SwitchPrimitive.Root><label htmlFor={id}>{label}</label></div>;
}
export function Tabs({ value, onValueChange, items, label = 'Sections', disabled = false }: { value: string; onValueChange: (value: string) => void | boolean | Promise<void | boolean>; items: { value: string; label: string; count?: number }[]; label?: string; disabled?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const activating = useRef(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  useEffect(() => {
    if (disabled || focusTarget === null || value !== focusTarget) return;
    const tab = refs.current[items.findIndex(item => item.value === focusTarget)];
    if (tab && (tab.parentElement?.contains(document.activeElement) || document.activeElement === document.body)) tab.focus();
    setFocusTarget(null);
  }, [disabled, focusTarget, items, value]);
  async function activate(index: number) {
    if (disabled || activating.current) return;
    activating.current = true;
    try {
      const accepted = await onValueChange(items[index].value);
      // Restore focus after React commits both the selected mode and the enabled controls.
      setFocusTarget(accepted === false ? value : items[index].value);
    } finally { activating.current = false; }
  }
  // One marker under the selected tab slides to the next one (200 ms); it lands without moving on first paint and when
  // a tab's width changes (a count, the web font).
  const marker = useRef<HTMLSpanElement>(null);
  const placed = useRef('');
  const index = items.findIndex(item => item.value === value), order = items.map(item => item.value).join('\n');
  useLayoutEffect(() => {
    const place = (animate: boolean) => {
      const bar = marker.current, tab = refs.current[index];
      if (!bar) return;
      // Sub-pixel layout positions, undoing any scale on an ancestor (a dialog opening).
      const list = bar.parentElement!, box = list.getBoundingClientRect(), rect = tab?.getBoundingClientRect(), scale = box.width / list.offsetWidth || 1;
      const at = rect ? `translate(${(rect.left - box.left) / scale - list.clientLeft + list.scrollLeft}px, ${(rect.bottom - box.top) / scale - list.clientTop + list.scrollTop - 1}px) scaleX(${rect.width / scale})` : '';
      if (at === placed.current) return;
      bar.toggleAttribute('data-animate', animate && placed.current !== '' && at !== '');
      bar.style.transform = at;
      bar.style.opacity = at ? '1' : '0';
      placed.current = at;
    };
    place(true);
    const observer = new ResizeObserver(() => place(false));
    for (const tab of refs.current) if (tab) observer.observe(tab);
    return () => observer.disconnect();
  }, [index, order]);
  return <div data-component="Tabs" className="ui-tabs ui-tabs--marker" role="tablist" aria-label={label}><span ref={marker} className="ui-tabs__marker" aria-hidden="true" />{items.map((item, index) => <button key={item.value} ref={node => { refs.current[index] = node; }} type="button" role="tab" disabled={disabled} aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} className="ui-tab" onClick={() => void activate(index)} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null; if (next !== null) { event.preventDefault(); void activate(next); } }}>{item.label}{item.count !== undefined && <span className="ui-tab__count">{item.count.toLocaleString()}</span>}</button>)}</div>;
}
// `sensitive`: the dialog shows a secret (a one-time key, a signing secret, an invitation link). Staff UI notes can't be
// left inside it and capture none of it (features/ui-notes).
export type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; sensitive?: boolean };
export function Dialog({ open, onOpenChange, title, description, children, footer, className, sensitive }: DialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const descriptionId = useId();
  // On a phone the dialog is a bottom sheet: in thumb reach, above the keyboard, swiped down to close.
  const sheet = usePhone();
  const drag = useSheetDrag(() => onOpenChange(false), sheet);
  // Native input autofocus can precede Radix's callback; retain the external opener, not the mounted input.
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="ui-dialog-overlay" /><DialogPrimitive.Content data-component="Dialog" data-sensitive={sensitive || undefined} {...drag} className={cx('ui-dialog', sheet && 'ui-dialog--sheet', className)} aria-describedby={description ? descriptionId : undefined} onFocusCapture={event => { const previous = event.relatedTarget; if (previous instanceof HTMLElement && previous !== document.body && !event.currentTarget.contains(previous)) returnFocus.current = previous; }} onOpenAutoFocus={event => { const focused = document.activeElement; const dialog = event.target; if (focused instanceof HTMLElement && (!(dialog instanceof HTMLElement) || !dialog.contains(focused))) returnFocus.current = focused; }} onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}>{sheet && <><SheetOpenEffects /><div className="ui-sheet__grab" aria-hidden="true"><span /></div></>}<div className="ui-dialog__header"><DialogPrimitive.Title className="ui-dialog__title">{title}</DialogPrimitive.Title><DialogPrimitive.Close asChild><IconButton label="Close dialog"><X size={16} /></IconButton></DialogPrimitive.Close></div>{description && <DialogPrimitive.Description id={descriptionId} className="ui-dialog__description">{description}</DialogPrimitive.Description>}<div className="ui-dialog__body">{children}</div>{footer && <div className="ui-dialog__footer">{footer}</div>}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', onConfirm, pending, danger = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; confirmLabel?: string; onConfirm: () => void | Promise<unknown>; pending?: boolean; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  const working = pending || busy;
  // One confirm at a time: a second press before the first answers (busy disables the button a render later) is ignored,
  // and a write the mutation guard drops (lib/single-flight.ts) isn't shown as an error; the first one closes the dialog.
  const confirming = useRef(false);
  async function confirm() { if (confirming.current) return; confirming.current = true; setBusy(true); setError(null); try { await onConfirm(); onOpenChange(false); } catch (cause) { if (isDuplicateSubmission(cause)) return; setError(cause instanceof Error ? cause.message : 'Couldn’t complete the action. Try again.'); } finally { confirming.current = false; setBusy(false); } }
  return <Dialog open={open} onOpenChange={next => { if (!working) onOpenChange(next); }} title={title} description={description} footer={<><Button disabled={working} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={working} onClick={confirm}>{confirmLabel}</Button></>}>{error ? <Alert tone="danger">{error}</Alert> : null}</Dialog>;
}
export type MenuItem = { label: string; onSelect: () => void; icon?: ReactNode; destructive?: boolean; disabled?: boolean; hint?: ReactNode };
export function DropdownMenu({ items, label = 'More actions', trigger, title }: { items: MenuItem[]; label?: string; trigger?: ReactNode; title?: ReactNode }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // A phone gets an action sheet: full-width rows at the bottom of the screen, and Cancel.
  if (phone) {
    const show = (event: { currentTarget: HTMLElement }) => { opener.current = event.currentTarget; setOpen(true); };
    const button = trigger && isValidElement(trigger) ? cloneElement(trigger as ReactElement<{ onClick?: (event: { currentTarget: HTMLElement }) => void }>, { onClick: show }) : <IconButton label={label} onClick={show}><MoreHorizontal size={16} /></IconButton>;
    return <>{button}<ActionSheet open={open} onOpenChange={setOpen} title={title ?? label} items={items} returnFocus={opener} /></>;
  }
  return <DropdownPrimitive.Root><DropdownPrimitive.Trigger asChild>{trigger ?? <IconButton label={label}><MoreHorizontal size={16} /></IconButton>}</DropdownPrimitive.Trigger><DropdownPrimitive.Portal><DropdownPrimitive.Content align="end" sideOffset={4} className="ui-popover ui-menu">{items.map((item, index) => <DropdownPrimitive.Item key={`${item.label}-${index}`} onSelect={item.onSelect} disabled={item.disabled} className={cx('ui-menu-item', item.destructive && 'ui-menu-item--danger')}><span className="ui-menu-icon">{item.icon}</span>{item.label}</DropdownPrimitive.Item>)}</DropdownPrimitive.Content></DropdownPrimitive.Portal></DropdownPrimitive.Root>;
}
// The actions run once the sheet has started closing, so a confirmation they open takes focus cleanly.
export function ActionSheet({ open, onOpenChange, title, items, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; items: MenuItem[]; returnFocus?: RefObject<HTMLElement | null> }) {
  return <Sheet open={open} onOpenChange={onOpenChange} title={title} className="ui-action-sheet" returnFocus={returnFocus}>
    <div className="ui-action-sheet__items" role="group">{items.map((item, index) => <button key={`${item.label}-${index}`} type="button" disabled={item.disabled} className={cx('ui-action-sheet__item', item.destructive && 'ui-action-sheet__item--danger')} onClick={() => { onOpenChange(false); setTimeout(item.onSelect, 0); }}>{item.icon && <span className="ui-menu-icon">{item.icon}</span>}<span className="ui-action-sheet__label">{item.label}{item.hint && <span className="ui-action-sheet__hint">{item.hint}</span>}</span></button>)}</div>
    <button type="button" className="ui-action-sheet__item ui-action-sheet__cancel" onClick={() => onOpenChange(false)}>Cancel</button>
  </Sheet>;
}
// On a phone every table renders as a list of cards, from the same column definitions (so a route skeleton and its loaded
// table always agree). A column's `card` slot places it: `title` (line 1, the row's link), `aside` (line 1, right),
// `line` (a muted line of its own), `inline` (joins the line above), `field` (a line with the column's label first),
// `end` (a control on the right, such as a row menu) or `hide`. Unset: the first column is the title, a column without a
// label is `end`, the rest are fields. `cardRender` replaces a column's cell in the card only; `table: false` keeps a
// column out of the table (a fact the table shows inside another cell).
export type CardSlot = 'title' | 'aside' | 'line' | 'inline' | 'field' | 'end' | 'hide';
export type Column<T> = { key: string; label: ReactNode; render: (row: T) => ReactNode; width?: string | number; align?: 'left' | 'right'; skeleton?: ReactNode; card?: CardSlot; cardRender?: (row: T) => ReactNode; table?: false };
export type SkeletonColumn = Pick<Column<never>, 'key' | 'label' | 'width' | 'align' | 'skeleton' | 'card' | 'table'>;
type CardShape<C> = { title?: C; aside: C[]; lines: { column: C; labelled: boolean }[][]; end: C[] };
function cardShape<C extends SkeletonColumn>(columns: C[]): CardShape<C> {
  const shape: CardShape<C> = { aside: [], lines: [], end: [] };
  columns.forEach((column, index) => {
    const slot = column.card ?? (index === 0 ? 'title' : column.label === '' || column.label == null ? 'end' : 'field');
    if (slot === 'hide') return;
    if (slot === 'title' && !shape.title) shape.title = column;
    else if (slot === 'aside') shape.aside.push(column);
    else if (slot === 'end') shape.end.push(column);
    else if (slot === 'inline' && shape.lines.length) shape.lines[shape.lines.length - 1].push({ column, labelled: false });
    else shape.lines.push([{ column, labelled: slot === 'field' }]);
  });
  return shape;
}
// Every card of a table is the same height (12 px padding, a 20 px title line, 24 px per further line, or the 44 px
// end control if taller), so its skeleton, a short page and a full page all hold the same space.
const cardHeight = (shape: CardShape<unknown>) => 25 + Math.max(20 + 24 * shape.lines.length, shape.end.length ? 44 : 0);
const cardLabel = (label: ReactNode) => typeof label === 'string' && label ? <span className="ui-card__label">{label}</span> : null;
// onRowIntent: a pointer resting on a row (not crossing it) or focus on it, before the click: warm what the row opens.
// rowHref: rows that open a page are real links. The first cell's content is an <a href> (keyboard, middle-click,
// "open in new tab"); a click anywhere else on the row follows it too, opening a new tab with a modifier or the middle
// button, while links and buttons inside the row keep their own action. Rows without an href use onRowClick (for
// example, opening a dialog). A card's title is the link (or button), stretched over the whole card.
type DataTableProps<T> = { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; onRowIntent?: (row: T) => void; rowHref?: (row: T) => string | null | undefined; selectedId?: string; empty?: ReactNode; loading?: boolean; skeletonRows?: number; minRows?: number; tableRef?: (node: HTMLDivElement | null) => void; className?: string; card?: boolean };
export function DataTable<T>(props: DataTableProps<T>) {
  const phone = usePhone();
  return phone && props.card !== false ? <CardList {...props} /> : <Table {...props} />;
}
function Table<T>({ columns: all, rows, rowKey, onRowClick, onRowIntent, rowHref, selectedId, empty, loading = false, skeletonRows = 5, minRows = 0, tableRef, className }: DataTableProps<T>) {
  const columns = all.filter(column => column.table !== false)
  const intent = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(intent.current), [])
  const rest = (row: T) => { window.clearTimeout(intent.current); intent.current = window.setTimeout(() => onRowIntent?.(row), 80) }
  const navigate = useNavigate()
  const own = (event: { target: EventTarget }) => Boolean((event.target as HTMLElement).closest('button, a, input, select, [role="checkbox"], [role="switch"]'))
  const follow = (href: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) window.open(href, '_blank', 'noopener'); else navigate(href) }
  return <div ref={tableRef} data-component="DataTable" className={cx('ui-table-scroll', className)} aria-busy={loading || undefined}>
    {loading && <span className="sr-only" role="status">Loading table</span>}
    <table className="ui-table"><thead><tr>{columns.map(column => <th scope="col" key={column.key} data-col={column.key} style={{ width: column.width, textAlign: column.align }}>{column.label}</th>)}</tr></thead>
      <tbody>{loading ? Array.from({ length: skeletonRows }, (_, index) => <tr key={index} aria-hidden="true">{columns.map((column, columnIndex) => <td key={column.key} data-col={column.key} data-skeleton-align={column.align}>{column.skeleton ?? <SkeletonText width={columnIndex === 0 ? '72%' : '58%'} />}</td>)}</tr>) : rows.map(row => { const id = rowKey(row), href = rowHref?.(row) || undefined, clickable = Boolean(href || onRowClick); return <tr key={id} data-selected={selectedId === id || undefined} className={href ? 'ui-table__clickable ui-table__linked' : onRowClick ? 'ui-table__clickable' : undefined} tabIndex={!href && onRowClick ? 0 : undefined} onClick={event => { if (own(event)) return; if (href) follow(href, event); else onRowClick?.(row); }} onAuxClick={event => { if (href && event.button === 1 && !own(event)) follow(href, event); }} onKeyDown={event => { if (!href && onRowClick && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onRowClick(row); } }} onPointerEnter={onRowIntent && (() => rest(row))} onPointerLeave={onRowIntent && (() => window.clearTimeout(intent.current))} onFocus={onRowIntent && (() => onRowIntent(row))} data-clickable={clickable || undefined}>{columns.map((column, index) => <td key={column.key} data-col={column.key} style={{ textAlign: column.align }}>{href && index === 0 ? <Link className="ui-row-link" to={href}>{column.render(row)}</Link> : column.render(row)}</td>)}</tr>; })}
        {!loading && rows.length > 0 && rows.length < minRows && <tr className="ui-table-spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height: `calc(${minRows - rows.length} * var(--table-row-height))` }} /></tr>}
      </tbody></table>
    {!loading && rows.length === 0 && <div className="ui-table-empty" style={{ minHeight: `calc(${minRows} * var(--table-row-height))` }}>{empty ?? <EmptyState title="No results" />}</div>}
  </div>;
}
function CardList<T>({ columns, rows, rowKey, onRowClick, onRowIntent, rowHref, selectedId, empty, loading = false, skeletonRows = 5, minRows = 0, tableRef, className }: DataTableProps<T>) {
  const shape = cardShape(columns), height = cardHeight(shape);
  const cell = (column: Column<T>, row: T) => (column.cardRender ?? column.render)(row);
  const style = { '--table-row-height': `${height}px` } as CSSProperties;
  return <div ref={tableRef} data-component="DataTable" className={cx('ui-cards', className)} style={style} aria-busy={loading || undefined}>
    {loading && <span className="sr-only" role="status">Loading list</span>}
    {(loading || rows.length > 0) && <ul className="ui-cards__list">{loading ? Array.from({ length: skeletonRows }, (_, index) => <li key={index} className="ui-card" aria-hidden="true">
      <div className="ui-card__main"><div className="ui-card__head"><span className="ui-card__title"><SkeletonText width="62%" /></span>{shape.aside.length > 0 && <span className="ui-card__aside"><SkeletonText width={56} /></span>}</div>
        {shape.lines.map((_, line) => <div key={line} className="ui-card__line"><SkeletonText width={`${[78, 52, 66, 44][line % 4]}%`} /></div>)}</div>
      {shape.end.length > 0 && <div className="ui-card__end"><ControlSkeleton width={44} /></div>}
    </li>) : rows.map(row => {
      const id = rowKey(row), href = rowHref?.(row) || undefined, title = shape.title ? cell(shape.title, row) : null;
      return <li key={id} className="ui-card" data-selected={selectedId === id || undefined} data-clickable={href || onRowClick ? true : undefined} onPointerDown={onRowIntent && (() => onRowIntent(row))} onFocus={onRowIntent && (() => onRowIntent(row))}>
        <div className="ui-card__main">
          <div className="ui-card__head"><span className="ui-card__title">{href ? <Link className="ui-row-link ui-card__link" to={href}>{title}</Link> : onRowClick ? <button type="button" className="ui-row-link ui-card__link" onClick={() => onRowClick(row)}>{title}</button> : title}</span>{shape.aside.map(column => <span key={column.key} className="ui-card__aside">{cell(column, row)}</span>)}</div>
          {shape.lines.map((segments, line) => <div key={line} className="ui-card__line">{segments.map(({ column, labelled }) => <span key={column.key} className="ui-card__segment">{labelled && cardLabel(column.label)}{cell(column, row)}</span>)}</div>)}
        </div>
        {shape.end.length > 0 && <div className="ui-card__end">{shape.end.map(column => <Fragment key={column.key}>{cell(column, row)}</Fragment>)}</div>}
      </li>;
    })}</ul>}
    {!loading && rows.length > 0 && rows.length < minRows && <div aria-hidden="true" style={{ height: (minRows - rows.length) * height }} />}
    {!loading && rows.length === 0 && <div className="ui-table-empty" style={{ minHeight: minRows * height }}>{empty ?? <EmptyState title="No results" />}</div>}
  </div>;
}
export function TableSkeleton({ columns, rows = 5, pagination = false, className }: { columns: SkeletonColumn[]; rows?: number; pagination?: boolean; className?: string }) {
  return <><DataTable className={className} columns={columns.map(column => ({ ...column, render: () => null }))} rows={[]} rowKey={() => ''} loading skeletonRows={rows} />{pagination && <PaginationSkeleton />}</>;
}
// Cursor lists don't know their total until the last page: they say which rows are showing ("Showing 21–40"), and on
// the last page how many there are in all, instead of a page size and a "2+" page count.
export function Pagination({ page, pageSize, total, nextCursor, onPageChange, count }: { page: number; pageSize: number; total?: number; nextCursor?: string | null; onPageChange: (page: number) => void; count?: number }) {
  if (total === undefined && page <= 1 && !nextCursor) return null;
  if (total === undefined) {
    const first = (page - 1) * pageSize + 1, last = first + Math.max(0, (count ?? pageSize) - 1);
    return <nav className="ui-pagination" aria-label="Pagination"><span className="muted">{count === undefined ? null : count === 0 ? 'No rows on this page' : `Showing ${first.toLocaleString()}–${last.toLocaleString()}${nextCursor ? '' : ` of ${last.toLocaleString()}`}`}</span><div className="cluster"><IconButton variant="secondary" label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} /></IconButton><span aria-live="polite">Page {page.toLocaleString()}</span><IconButton variant="secondary" label="Next page" disabled={!nextCursor} onClick={() => onPageChange(page + 1)}><ChevronRight size={14} /></IconButton></div></nav>;
  }
  return <NumberedPagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
}
function NumberedPagination({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const validPage = Math.min(pages, Math.max(1, page));
  useEffect(() => { if (page !== validPage) onPageChange(validPage); }, [page, validPage, onPageChange]);
  if (page !== validPage) return <nav className="ui-pagination" aria-label="Pagination"><span className="muted" role="status">Updating page…</span></nav>;
  if (pages === 1) return null;
  return <nav className="ui-pagination" aria-label="Pagination"><span className="muted">{total === 0 ? '0 results' : `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`}</span><div className="cluster"><IconButton variant="secondary" label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} /></IconButton><span aria-live="polite">{page} / {pages}</span><IconButton variant="secondary" label="Next page" disabled={page >= pages} onClick={() => onPageChange(page + 1)}><ChevronRight size={14} /></IconButton></div></nav>;
}
// The back arrow returns to where you came from, like the browser's Back, when you got here inside the dashboard: the
// previous page comes back with its tab, filters and scroll. Opened directly (a pasted or new-tab link), it goes up to
// backTo instead. It is a real link to backTo either way, so it still opens in a new tab.
function BackLink({ to }: { to: string }) {
  const navigate = useNavigate(), location = useLocation()
  return <Link className="ui-button ui-button--secondary ui-icon-button" to={to} aria-label="Go back" onClick={event => {
    if (location.key === 'default' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault(); navigate(-1)
  }}><ArrowLeft size={16} /></Link>
}
export function PageHeader({ title, actions, backTo }: { title: ReactNode; actions?: ReactNode; backTo?: string }) {
  return <header data-component="PageHeader" className="ui-page-header"><div className="cluster">{backTo && <BackLink to={backTo} />}<h1>{title}</h1></div>{actions && <div className="cluster">{actions}</div>}</header>;
}
export function SectionHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return <div data-component="SectionHeader" className="ui-section-header"><h2>{title}</h2>{actions && <div className="cluster">{actions}</div>}</div>;
}
function statusTone(status: string): Tone {
  const value = status.trim().toLowerCase().replaceAll(' ', '_');
  if (['delivered', 'sent', 'done', 'active', 'verified', 'enabled', 'subscribed', 'healthy', 'connected', 'completed', 'success', 'production'].includes(value)) return 'success';
  if (['pending', 'preparing', 'scheduled', 'sending', 'paused', 'queued', 'warning', 'verifying', 'bounced', 'deferred', 'delivery_delayed', 'sandbox', 'probation', 'issue', 'attention'].includes(value)) return 'warning';
  if (['failed', 'complaint', 'error', 'rejected', 'suppressed', 'shutdown'].includes(value)) return 'danger';
  return 'neutral';
}
// A badge in a cell narrower than its label shortens the label with an ellipsis and says the whole of it on hover.
export function StatusBadge({ status, tone = statusTone(status) }: { status: string; tone?: Tone }) {
  const text = formatLabel(status);
  return <span data-component="StatusBadge" className={cx('ui-status', `ui-tone--${tone}`)} onPointerEnter={event => { const label = event.currentTarget.lastElementChild; event.currentTarget.title = label && label.scrollWidth > label.clientWidth ? text : ''; }}><span className="ui-status__dot" aria-hidden="true" /><span className="ui-status__label">{text}</span></span>;
}
// A status as one quiet line of a table cell: the tone's dot, the value itself (a host, say) and an optional muted note.
// The note gives way first when the cell is narrow; `title` carries the whole text for whatever is clipped.
export function StatusDot({ tone, children, note, title, muted = false }: { tone: Tone; children: ReactNode; note?: ReactNode; title?: string; muted?: boolean }) {
  return <span className={cx('ui-status-dot', `ui-tone--${tone}`, muted && 'ui-status-dot--muted')} title={title}><span className="ui-status__dot" aria-hidden="true" /><span className="ui-status-dot__value">{children}</span>{note && <span className="ui-status-dot__note">{note}</span>}</span>;
}
// `timer`: a notice that dismisses itself shows the time it has left as a thin bar that empties (paused while `paused`).
export function Alert({ tone = 'neutral', title, children, onDismiss, timer, ...rest }: { tone?: Tone; title?: ReactNode; children: ReactNode; onDismiss?: () => void; timer?: { duration: number; paused: boolean } } & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'>) {
  return <div data-component="Alert" {...rest} className={cx('ui-alert', `ui-tone--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}><div>{title && <div className="ui-alert__title">{title}</div>}<div>{children}</div></div>{onDismiss && <IconButton label="Dismiss notification" onClick={onDismiss}><X size={14} /></IconButton>}{timer && <span className="ui-alert__timer" aria-hidden="true" style={{ animationDuration: `${timer.duration}ms`, animationPlayState: timer.paused ? 'paused' : 'running' }} />}</div>;
}
export function EmptyState({ title, description, action, headingAs: Heading = 'h3' }: { title: string; description?: string; action?: ReactNode; headingAs?: 'h1' | 'h3' }) {
  return <div data-component="EmptyState" className="ui-empty-state"><Heading>{title}</Heading>{description && <p className="muted">{description}</p>}{action && <div>{action}</div>}</div>;
}
export function LoadingState({ rows = 5 }: { rows?: number }) {
  return <div className="ui-loading" role="status" aria-label="Loading"><span className="sr-only">Loading…</span>{Array.from({ length: rows }, (_, index) => <div key={index} className="ui-skeleton-row" aria-hidden="true"><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>)}</div>;
}
// API errors carry plain-language `text` and a `reference` (code and request ID) shown as secondary detail.
export function ErrorText({ error, fallback = 'Something went wrong. Please try again.' }: { error: unknown; fallback?: string }) {
  if (error instanceof Error && 'text' in error && 'reference' in error) return <><span>{String(error.text)}</span><span className="ui-error-reference">{String(error.reference)}</span></>;
  return <>{error instanceof Error ? error.message : typeof error === 'string' ? error : fallback}</>;
}
// A role that can't open something isn't a failure: a calm note with who can, and no retry that would fail again.
const permissionError = (error: unknown) => error instanceof Error && 'code' in error && permissionCodes.has(String(error.code));
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (permissionError(error)) return <div className="ui-error-state"><Alert tone="neutral" title="Owners and admins only"><span>{error instanceof Error && 'text' in error ? String(error.text) : 'Only workspace owners and admins can open this.'}</span></Alert></div>;
  return <div className="ui-error-state"><Alert tone="danger" title="Couldn’t load this content"><ErrorText error={error} />{onRetry && <div className="ui-error-state__retry"><Button onClick={onRetry}>Try again</Button></div>}</Alert></div>;
}
type ToastTone = 'success' | 'error' | 'info';
type ToastFn = (message: string, tone?: ToastTone) => void;
const ToastContext = createContext<ToastFn | null>(null);
const KEPT_TOASTS = 'bane.kept-toasts';
const TOAST_MS = 6000;
// A toast stays 6 s, and the time stops while a pointer rests on it or focus is inside it.
function Toast({ id, tone, message, dismiss }: { id: number; tone: ToastTone; message: string; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const onDismiss = useCallback(() => dismiss(id), [dismiss, id]);
  const left = useRef(TOAST_MS);
  useEffect(() => {
    if (paused) return;
    const started = Date.now(), timer = setTimeout(onDismiss, left.current);
    return () => { clearTimeout(timer); left.current -= Date.now() - started; };
  }, [paused, onDismiss]);
  return <Alert tone={tone === 'error' ? 'danger' : tone} onDismiss={onDismiss} timer={{ duration: TOAST_MS, paused }} onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>{message}</Alert>;
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: ToastTone }[]>([]);
  const sequence = useRef(0);
  const dismiss = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);
  const toast = useCallback<ToastFn>((message, tone = 'info') => { const id = ++sequence.current; setToasts(current => [...current.slice(-3), { id, message, tone }]); }, []);
  // A reload for a new build (lib/preloadable.ts) keeps what was just confirmed, such as "Joined <workspace>".
  const shown = useRef(toasts); shown.current = toasts;
  useEffect(() => {
    try { const kept = sessionStorage.getItem(KEPT_TOASTS); sessionStorage.removeItem(KEPT_TOASTS); if (kept) for (const { message, tone } of JSON.parse(kept) as { message: string; tone: ToastTone }[]) toast(message, tone); } catch { /* Nothing to restore. */ }
    const keep = () => { try { sessionStorage.setItem(KEPT_TOASTS, JSON.stringify(shown.current.map(({ message, tone }) => ({ message, tone })))); } catch { /* The toasts go with the page. */ } };
    window.addEventListener('bane:reloading', keep);
    return () => window.removeEventListener('bane:reloading', keep);
  }, [toast]);
  return <ToastContext.Provider value={toast}>{children}<div className="ui-toasts" aria-label="Notifications">{toasts.map(item => <Toast key={item.id} id={item.id} tone={item.tone} message={item.message} dismiss={dismiss} />)}</div></ToastContext.Provider>;
}
export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used inside ToastProvider');
  return toast;
}
/** A secret shown in full (a key, signing secret or link that grants access): marked so UI notes never capture it. */
export function SecretCode({ children, className }: { children: ReactNode; className?: string }) {
  return <code data-sensitive className={className}>{children}</code>;
}
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useContext(ToastContext);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="cluster"><IconButton label={copied ? 'Copied' : label} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setError(false); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); } catch { setError(true); toast?.('Couldn’t copy to clipboard.', 'error'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton><span className="sr-only" role="status">{copied ? 'Copied to clipboard' : error ? 'Couldn’t copy to clipboard' : ''}</span></span>;
}
