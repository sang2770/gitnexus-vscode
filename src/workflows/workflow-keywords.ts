export type LocalizedKeywordWorkflow =
  | 'architecture'
  | 'develop'
  | 'detect_change'
  | 'explain'
  | 'fix'
  | 'impact'
  | 'plan'
  | 'review'
  | 'test'
  | 'verify';

const LOCALIZED_TERMS: Record<LocalizedKeywordWorkflow, string[]> = {
  architecture: ['kiến trúc', 'tổng quan hệ thống'],
  develop: ['phát triển', 'tính năng', 'triển khai'],
  detect_change: ['phát hiện thay đổi'],
  explain: ['giải thích', 'luồng xử lý', 'hoạt động thế nào'],
  fix: ['sửa lỗi', 'lỗi xảy ra', 'bị hỏng'],
  impact: ['ảnh hưởng', 'phạm vi tác động'],
  plan: ['lập kế hoạch', 'kế hoạch triển khai'],
  review: ['xem xét code', 'review thay đổi'],
  test: ['kế hoạch kiểm thử', 'viết kiểm thử', 'tạo test', 'độ phủ kiểm thử'],
  verify: ['xác minh', 'kiểm tra thay đổi', 'kiểm thử thay đổi', 'chạy kiểm thử', 'sẵn sàng merge'],
};

export function matchesLocalizedWorkflow(text: string, workflow: LocalizedKeywordWorkflow): boolean {
  const normalized = text.toLocaleLowerCase();
  return LOCALIZED_TERMS[workflow].some((term) => normalized.includes(term));
}
