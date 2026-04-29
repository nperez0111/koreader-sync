export interface User {
  id: number;
  username: string;
  password: string;
  created_at: Date;
}

export interface DocumentMetadata {
  filename?: string;
  title?: string;
  authors?: string;
}

export interface Progress {
  id: number;
  user_id: number;
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  filename: string | null;
  title: string | null;
  authors: string | null;
  timestamp: number;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface ProgressUpdateRequest {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  metadata?: DocumentMetadata;
}
