// Own profile (spec §8.1; decision D-35). The employee reads their record and
// maintains their own phone numbers; every other field is HR's.

import { Alert, App, Button, Card, Descriptions, Flex, Form, Input, Spin } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { phoneRule } from '../../lib/phone';
import { useMyEmployee, useUpdateOwnContact } from './api';

type Phones = { primaryPhone?: string; emergencyContactPhone?: string };

export default function MyProfilePage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const me = useMyEmployee();
  const save = useUpdateOwnContact();
  const [form] = Form.useForm<Phones>();

  if (me.isLoading) return <Spin />;
  if (me.error || !me.data) return <Alert type="warning" showIcon title={describeApiError(me.error)} />;
  const e = me.data;

  return (
    <Flex vertical gap={16}>
      <Card title={t('myProfile')}>
        <Descriptions column={1} size="small" bordered items={[
          ['jobNumber', e.jobNumber], ['name', e.fullName], ['unit', e.unit ? `${e.unit.code} — ${e.unit.name}` : t('unassigned')],
          ['position', `${e.position.code} — ${e.position.title}`], ['jobTitle', e.jobTitle], ['contactEmail', e.contactEmail],
        ].map(([k, v]) => ({ key: k as string, label: t(k as string), children: (v as string | null) ?? '—' }))} />
      </Card>
      <Card title={t('myPhones')}>
        <Alert type="info" showIcon title={t('myPhonesHint')} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" style={{ maxWidth: 480 }}
          initialValues={{ primaryPhone: e.primaryPhone ?? '', emergencyContactPhone: e.emergencyContactPhone ?? '' }}
          onFinish={async (v) => {
            try {
              await save.mutateAsync({ version: me.data?.updatedAt, primaryPhone: v.primaryPhone || null, emergencyContactPhone: v.emergencyContactPhone || null });
              message.success(t('saved'));
            } catch (err) { message.error(describeApiError(err)); }
          }}>
          <Form.Item name="primaryPhone" label={t('primaryPhone')} extra={t('phoneHint')} rules={[phoneRule(t('phoneInvalid'))]}><Input maxLength={24} dir="ltr" /></Form.Item>
          <Form.Item name="emergencyContactPhone" label={t('emergencyContactPhone')} extra={t('emergencyPhoneHint')} rules={[phoneRule(t('phoneInvalid'))]}><Input maxLength={24} dir="ltr" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={save.isPending}>{t('submit')}</Button>
        </Form>
      </Card>
    </Flex>
  );
}
