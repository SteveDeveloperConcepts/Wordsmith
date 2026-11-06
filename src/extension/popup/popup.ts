/// <reference types="chrome" />
/** The toolbar popup: a few switches over chrome.storage.sync, and the way to grant the current site. */
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, DIALECT_LABEL, type Category, type Dialect } from '@engine/types';
import { loadSettings, saveSettings, setSiteOn, type ExtensionSettings } from '../shared/settings';
import { sitePattern, unsupportedSurface } from '../shared/sites';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enabled = byId<HTMLInputElement>('enabled');
const dialect = byId<HTMLSelectElement>('dialect');
const categories = byId<HTMLDivElement>('categories');
const site = byId<HTMLElement>('site');

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light';
};

function line(text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.textContent = text;
  return element;
}

function siteSwitch(host: string, settings: ExtensionSettings): HTMLElement {
  const label = document.createElement('label');
  label.className = 'row';
  const name = document.createElement('span');
  name.textContent = `Check ${host}`;
  const toggle = document.createElement('input');
  toggle.id = 'site-on';
  toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch');
  toggle.checked = !settings.disabledSites.includes(host);
  toggle.addEventListener('change', () => {
    void saveSettings({ disabledSites: setSiteOn(settings, host, toggle.checked) }).then(render);
  });
  label.append(name, toggle);
  return label;
}

function grantButton(host: string, pattern: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = 'grant';
  button.type = 'button';
  button.textContent = `Turn on for ${host}`;
  // The request has to be made straight from the click. The service worker takes over from there.
  button.addEventListener('click', () => {
    void chrome.permissions.request({ origins: [pattern] }).then(render);
  });
  return button;
}

async function renderSite(settings: ExtensionSettings): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  const pattern = url && sitePattern(url);
  if (!url || !pattern) {
    site.replaceChildren(line('Wordsmith works on web pages. This page cannot be checked.'));
    return;
  }

  const unsupported = unsupportedSurface(url);
  if (unsupported) {
    site.replaceChildren(line(unsupported));
    return;
  }

  const host = url.hostname;
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  site.replaceChildren(
    ...(granted
      ? [siteSwitch(host, settings)]
      : [line(`Wordsmith is not turned on for ${host}.`), grantButton(host, pattern)]),
  );
}

function renderCategories(settings: ExtensionSettings): void {
  categories.replaceChildren(
    ...CATEGORIES.map((category: Category) => {
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.category = category;
      box.checked = settings.checks[category];
      box.addEventListener('change', () => {
        void saveSettings({ checks: { ...settings.checks, [category]: box.checked } }).then(render);
      });
      const text = document.createElement('span');
      text.textContent = CATEGORY_LABEL[category];
      const hint = document.createElement('small');
      hint.textContent = CATEGORY_HINT[category];
      text.append(hint);
      label.append(box, text);
      return label;
    }),
  );
}

async function render(): Promise<void> {
  const settings = await loadSettings();
  enabled.checked = settings.enabled;
  dialect.value = settings.dialect;
  document.querySelector('.popup')?.setAttribute('data-off', String(!settings.enabled));
  renderCategories(settings);
  await renderSite(settings);
}

enabled.addEventListener('change', () => {
  void saveSettings({ enabled: enabled.checked }).then(render);
});
dialect.addEventListener('change', () => {
  void saveSettings({ dialect: dialect.value as Dialect });
});

byId<HTMLImageElement>('mark').src = chrome.runtime.getURL('icons/icon-32.png');
dialect.append(
  ...Object.entries(DIALECT_LABEL).map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label.replace(' English', '');
    return option;
  }),
);
applyTheme();
dark.addEventListener('change', applyTheme);
void render();
