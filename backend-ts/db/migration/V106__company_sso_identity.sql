CREATE TABLE user_identity_write_lock (
    id TINYINT NOT NULL PRIMARY KEY
) ENGINE=InnoDB;
INSERT INTO user_identity_write_lock (id) VALUES (1);

CREATE TABLE user_external_identity (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    user_id BIGINT NOT NULL,
    email_at_binding VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_external_provider_subject (provider, subject),
    UNIQUE KEY uk_external_provider_user (provider, user_id),
    CONSTRAINT fk_external_identity_user FOREIGN KEY (user_id) REFERENCES `user` (id)
) ENGINE=InnoDB;
