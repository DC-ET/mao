declare module 'ali-oss' {
  interface OSSOptions {
    region?: string
    accessKeyId: string
    accessKeySecret: string
    stsToken?: string
    bucket?: string
    endpoint?: string
    cname?: boolean
    secure?: boolean
    timeout?: string | number
  }

  interface PutResult {
    name: string
    url: string
    res: { status: number; headers: Record<string, string> }
  }

  interface PutOptions {
    mime?: string
    headers?: Record<string, string>
    meta?: Record<string, string>
    callback?: Record<string, unknown>
  }

  class OSS {
    constructor(options: OSSOptions)
    put(name: string, file: File | Blob | Buffer | string, options?: PutOptions): Promise<PutResult>
    putStream(name: string, stream: any, options?: PutOptions): Promise<PutResult>
    get(name: string, file?: string): Promise<{ content: Buffer; res: { status: number } }>
    delete(name: string): Promise<{ res: { status: number } }>
    list(query?: { prefix?: string; marker?: string; 'max-keys'?: string }): Promise<{ objects: any[]; prefixes: string[] }>
  }

  export default OSS
}
