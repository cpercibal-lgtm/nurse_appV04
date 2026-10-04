// Who a credential type applies to (owner decision 2026-10-04): nothing for every
// nationality; "Only: Saudi" or "Optional for: Saudi" otherwise, in the current language.

import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { nationalityLabel, useNationalities } from '../../components/NationalitySelect';
import type { NationalityRule } from './api';

/** The rule as text, or '' for every nationality. */
export function useNationalityRuleText() {
  const { t, i18n } = useTranslation();
  const list = useNationalities();
  return (rule: NationalityRule, codes: readonly string[]) => {
    if (rule === 'ALL') return '';
    const names = codes.map((c) => {
      const n = list.data?.items.find((x) => x.code === c);
      return n ? nationalityLabel(n, i18n.language === 'ar') : c;
    }).join(', ');
    return t(rule === 'ONLY' ? 'nationalityOnlyTag' : 'nationalityExceptTag', { list: names });
  };
}

export function NationalityRuleTag({ rule, codes }: { rule: NationalityRule; codes: readonly string[] }) {
  const text = useNationalityRuleText()(rule, codes);
  return text ? <Tag color={rule === 'ONLY' ? 'purple' : 'gold'}>{text}</Tag> : null;
}
