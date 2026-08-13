export interface SkillDocument {
  name: string;
  description?: string | null;
  body?: string | null;
  filePath?: string | null;
  folderPath?: string | null;
}

export interface LocalSkillRef {
  name: string;
  description?: string | null;
  folderName?: string | null;
}
