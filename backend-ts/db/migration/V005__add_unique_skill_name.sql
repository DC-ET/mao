-- Remove duplicate skills, keeping the one with the smallest id
-- Only run if skill table exists (not renamed to tool yet)
DROP PROCEDURE IF EXISTS cleanup_skills;
DELIMITER //
CREATE PROCEDURE cleanup_skills()
BEGIN
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skill') THEN
        DELETE FROM skill WHERE id NOT IN (
            SELECT min_id FROM (SELECT MIN(id) AS min_id FROM skill GROUP BY name) AS t
        );

        -- Add unique constraint on skill name if not exists
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skill' AND INDEX_NAME = 'uk_skill_name') THEN
            ALTER TABLE skill ADD UNIQUE KEY uk_skill_name (name);
        END IF;
    END IF;
END //
DELIMITER ;
CALL cleanup_skills();
DROP PROCEDURE cleanup_skills;
