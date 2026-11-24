CREATE TABLE `user_company_sso_token` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `token_enc` TEXT NOT NULL COMMENT 'AES-GCM 加密的公司 SSO token',
    `expires_at` DATETIME NOT NULL COMMENT 'SSO token 过期时间（claims.exp，上海墙钟）',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_company_sso_token_user` (`user_id`),
    CONSTRAINT `fk_user_company_sso_token_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户最近一次公司 SSO 换票凭证（加密存储，每次换票覆盖）';
