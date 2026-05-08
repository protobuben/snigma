export interface Message {
  role:    "user" | "assistant";
  content: string;
}

export interface StoredSession {
  id:               string;
  timestamp:        number;
  focusB64:         string;
  focusMime?:       string;
  messages:         Message[];
  summary?:         string | null;
  summarizedCount?: number;
}
