// Credential type names and field labels in the interface language (owner, 2026-10-05):
// the Arabic text when the interface is Arabic and one is stored, the English one otherwise.

import { useTranslation } from 'react-i18next';
import type { FieldDef } from './api';

export interface TypeName { code: string; name: string; nameAr?: string | null }

export const typeName = (t: Pick<TypeName, 'name' | 'nameAr'>, ar: boolean) => (ar && t.nameAr ? t.nameAr : t.name);
/** "BLS — Basic Life Support (BLS)": the code stays as it is in both languages. */
export const typeLabel = (t: TypeName, ar: boolean) => `${t.code} — ${typeName(t, ar)}`;
export const fieldLabel = (d: Pick<FieldDef, 'label' | 'labelAr'>, ar: boolean) => (ar && d.labelAr ? d.labelAr : d.label);

export function useTypeLabels() {
  const { i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  return {
    ar,
    typeName: (t: Pick<TypeName, 'name' | 'nameAr'>) => typeName(t, ar),
    typeLabel: (t: TypeName) => typeLabel(t, ar),
    fieldLabel: (d: Pick<FieldDef, 'label' | 'labelAr'>) => fieldLabel(d, ar),
  };
}
