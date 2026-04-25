export const IDENTITY_OPTIONS = [
  '本人',
  '客户',
  '销售',
  '面试官',
  '候选人',
  '同事',
  '老板',
  '下属',
  '老师',
  '学生',
  '家人',
  '朋友',
  '其他',
] as const;

export type IdentityOption = typeof IDENTITY_OPTIONS[number];

export function isValidIdentityLabel(value: string | null | undefined): boolean {
  if (value == null || value.trim() === '') {
    return true;
  }
  return IDENTITY_OPTIONS.includes(value.trim() as IdentityOption);
}
