export interface User {
  id: number;
  username: string;
  password: string;
  created_at: Date;
}

export interface Progress {
  id: number;
  user_id: number;
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
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
}
