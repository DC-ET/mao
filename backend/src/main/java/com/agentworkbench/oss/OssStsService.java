package com.agentworkbench.oss;

import com.aliyuncs.DefaultAcsClient;
import com.aliyuncs.IAcsClient;
import com.aliyuncs.exceptions.ClientException;
import com.aliyuncs.http.MethodType;
import com.aliyuncs.auth.sts.AssumeRoleRequest;
import com.aliyuncs.auth.sts.AssumeRoleResponse;
import com.aliyuncs.profile.DefaultProfile;
import com.agentworkbench.common.exception.BusinessException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Slf4j
@Service
@RequiredArgsConstructor
public class OssStsService {

    private final OssProperties ossProperties;

    public StsTokenVO generateStsToken(Long userId, Long sessionId) {
        OssProperties.Sts sts = ossProperties.getSts();

        try {
            DefaultProfile.addEndpoint(sts.getRegionId(), "Sts", sts.getEndpoint());
            IAcsClient client = new DefaultAcsClient(
                    DefaultProfile.getProfile(sts.getRegionId(), sts.getAccessKeyId(), sts.getAccessKeySecret()));

            AssumeRoleRequest request = new AssumeRoleRequest();
            request.setSysMethod(MethodType.POST);
            request.setRoleArn(sts.getRoleArn());
            request.setRoleSessionName("User_" + userId);
            request.setDurationSeconds(sts.getExpire());

            // Restrict policy: only allow putObject to session path
            String uploadDir = "session/" + sessionId + "/";
            String policy = """
                    {
                      "Version": "1",
                      "Statement": [
                        {
                          "Effect": "Allow",
                          "Action": [
                            "oss:PutObject",
                            "oss:PutObjectAcl"
                          ],
                          "Resource": [
                            "acs:oss:*:*:%s/%s*"
                          ]
                        }
                      ]
                    }
                    """.formatted(ossProperties.getBucket(), uploadDir);
            request.setPolicy(policy);

            AssumeRoleResponse response = client.getAcsResponse(request);
            AssumeRoleResponse.Credentials creds = response.getCredentials();

            StsTokenVO vo = new StsTokenVO();
            vo.setAccessKeyId(creds.getAccessKeyId());
            vo.setAccessKeySecret(creds.getAccessKeySecret());
            vo.setSecurityToken(creds.getSecurityToken());
            vo.setExpiration(creds.getExpiration());
            vo.setBucket(ossProperties.getBucket());
            vo.setRegion(ossProperties.getRegion());
            vo.setUploadDir(uploadDir);
            return vo;

        } catch (ClientException e) {
            log.error("Failed to generate STS token for userId={}, sessionId={}", userId, sessionId, e);
            throw new BusinessException(5001, "生成 OSS 临时凭证失败: " + e.getMessage());
        }
    }
}
