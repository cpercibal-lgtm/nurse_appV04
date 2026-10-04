// Nationality dropdown (owner decision 2026-10-03): the fixed standard list from
// GET /nationalities — searchable, alphabetical in the current language, codes as
// values (ISO 3166-1 alpha-3). Reuse it wherever a nationality is chosen.

import { useMemo } from 'react';
import { Select, type SelectProps } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { http } from '../services/http';

export interface Nationality { code: string; name: string; nameAr: string | null; countryName: string }

/** The list never changes while the application runs (it comes with a release). */
export const useNationalities = () => useQuery({
  queryKey: ['nationalities'], staleTime: Infinity, gcTime: Infinity,
  queryFn: () => http.get<{ items: Nationality[] }>('/nationalities'),
});

export function nationalityLabel(n: Pick<Nationality, 'name' | 'nameAr'>, ar: boolean) {
  return ar && n.nameAr ? n.nameAr : n.name;
}

/** Form control: value is the code (several codes with mode="multiple"). Searches the nationality, the country and the code. */
export function NationalitySelect<V extends string | string[] = string>(props: Omit<SelectProps<V>, 'options' | 'showSearch'>) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const list = useNationalities();
  const options = useMemo(() => (list.data?.items ?? [])
    .map((n) => ({ value: n.code, label: nationalityLabel(n, ar), search: `${n.name} ${n.nameAr ?? ''} ${n.countryName} ${n.code}`.toLowerCase() }))
    .sort((a, b) => a.label.localeCompare(b.label, ar ? 'ar' : 'en')), [list.data, ar]);
  return (
    <Select<V> placeholder={t('nationalitySelect')} loading={list.isLoading} options={options}
      showSearch={{ filterOption: (input, o) => (o?.search ?? '').includes(input.trim().toLowerCase()) }} {...props} />
  );
}
