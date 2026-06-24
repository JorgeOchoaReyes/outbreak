export interface ApiSpec {
  type: 'openapi' | 'raw';
  content: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedSDK {
  description: string;
  files: GeneratedFile[];
}

export interface GenerateOptions {
  name: string;
  docsUrl: string;
  skipPR?: boolean;
}
