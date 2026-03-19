export const esc = (v: string): string =>
  v.replaceAll('&', '&amp;')
   .replaceAll('<', '&lt;')
   .replaceAll('>', '&gt;')
   .replaceAll('"', '&quot;')
   .replaceAll("'", '&#39;');

export const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export const getVal = (id: string): string => ($<HTMLInputElement>(id)?.value ?? '').trim();

export const setVal = (id: string, v: string | number): void => {
  const el = $<HTMLInputElement>(id);
  if (el) el.value = String(v);
};

export const getSelectVal = (id: string): string => ($<HTMLSelectElement>(id)?.value ?? '').trim();
