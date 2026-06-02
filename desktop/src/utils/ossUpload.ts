import OSS from 'ali-oss'

export interface StsToken {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  bucket: string
  region: string
  uploadDir: string
  expiration: string
}

export async function uploadToOss(file: File, stsToken: StsToken): Promise<string> {
  const client = new OSS({
    region: stsToken.region,
    accessKeyId: stsToken.accessKeyId,
    accessKeySecret: stsToken.accessKeySecret,
    stsToken: stsToken.securityToken,
    bucket: stsToken.bucket,
  })

  const key = `${stsToken.uploadDir}${Date.now()}_${file.name}`
  const result = await client.put(key, file)
  return result.url
}
