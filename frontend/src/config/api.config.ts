export const API_CONFIG = {
  BASE_URL: import.meta.env.VITE_API_URL || '',
  TIMEOUT: 300000,
} as const;

export const API_ENDPOINTS = {
  AUTH: {
    LOGIN: '/api/auth/login/',
    SIGNUP: '/api/auth/signup/',
    LOGOUT: '/api/auth/logout/',
    REFRESH: '/api/auth/refresh/',
    ME: '/api/auth/me/',
  },
  VIDEOS: {
    UPLOAD: '/api/videos/upload/chunk/',
    COMPLETE: '/api/videos/upload/complete/',
    LIST: '/api/videos/list/',
    DETAIL: (id: number) => `/api/videos/detail/${id}/`,
    STREAM: (id: string) => `/api/videos/stream/${id}/`,
    DOWNLOAD: (id: string) => `/api/videos/download/${id}/`,
    ABORT: (id: number) => `/api/videos/${id}/abort/`,
    DELETE: (id: number) => `/api/videos/${id}/`,
    RENAME: (id: number) => `/api/videos/${id}/rename/`,
    SYNC: '/api/videos/sync/',
  },
  PDFS: {
    UPLOAD: '/api/videos/pdfs/upload/',
    LIST: '/api/videos/pdfs/list/',
    DETAIL: (id: number) => `/api/videos/pdfs/${id}/`,
    DELETE: (id: number) => `/api/videos/pdfs/${id}/delete/`,
    STREAM: (fileId: string) => `/api/videos/pdfs/stream/${fileId}/`,
    ANNOTATIONS: (pdfId: number) => `/api/videos/pdfs/${pdfId}/annotations/`,
    ANNOTATION_DETAIL: (id: number) => `/api/videos/pdfs/annotations/${id}/`,
  },
  VAULT: {
    CATEGORIES: '/api/vault/categories/',
    ORGANIZATIONS: '/api/vault/organizations/',
    CHAPTERS: '/api/vault/chapters/',
    CHAPTER_NOTE: (chapterId: number) => `/api/vault/chapters/${chapterId}/note/`,
    SYNC_ALL: '/api/vault/sync-all/',
  },
  TELEGRAM: {
    CONFIG: '/api/telegram/config/',
    SEND_OTP: '/api/telegram/send-otp/',
    VERIFY_OTP: '/api/telegram/verify-otp/',
    GROUP_MEDIA: '/api/telegram/group-media/',
    DOWNLOAD: '/api/telegram/download/',
    CANCEL: '/api/telegram/cancel/',
    STATUS: '/api/telegram/status/',
  },
} as const;
