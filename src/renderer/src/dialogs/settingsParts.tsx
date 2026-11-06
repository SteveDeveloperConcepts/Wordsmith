import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { openExternal } from '../platform';
import '../styles/settings.css';

interface SettingProps {
  label: string;
  hint?: string;
  /** The id of the control, when it is a single form field. */
  controlId?: string;
  children: ReactNode;
}

export function Setting({ label, hint, controlId, children }: SettingProps) {
  return (
    <div className="setting">
      <div className="setting__text">
        {controlId ? (
          <label className="setting__label" htmlFor={controlId}>
            {label}
          </label>
        ) : (
          <span className="setting__label">{label}</span>
        )}
        {hint && <p className="setting__hint">{hint}</p>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

interface SwitchProps {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  /** Shown before the label. */
  lead?: ReactNode;
  onChange(checked: boolean): void;
}

export function Switch({ label, hint, checked, disabled = false, lead, onChange }: SwitchProps) {
  return (
    <label className={`setting setting--switch${disabled ? ' is-disabled' : ''}`}>
      {lead}
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        <span className="setting__hint">{hint}</span>
      </span>
      <span className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch__track" aria-hidden />
      </span>
    </label>
  );
}

interface GroupProps {
  title: string;
  children: ReactNode;
}

export function Group({ title, children }: GroupProps) {
  return (
    <section className="settings-group">
      <h4 className="settings-group__title">{title}</h4>
      {children}
    </section>
  );
}

export function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="link settings-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        openExternal(href);
      }}
    >
      {children}
      <ExternalLink size={12} aria-hidden />
    </a>
  );
}
