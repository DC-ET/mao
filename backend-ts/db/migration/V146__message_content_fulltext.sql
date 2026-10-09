-- V146: 消息正文全文索引（ngram 中文分词），支撑全局消息检索。
-- 注意：MySQL 8 FULLTEXT 创建不支持 LOCK=NONE，最低 LOCK=SHARED（阻塞写、不阻塞读），
-- 且需重建表添加隐藏 FTS_DOC_ID 列。启动时执行期间的写入阻塞影响见部署文档。
-- 空停用词表必须在同一连接、ALTER 之前设到会话上，索引内容按这个表固化。
CREATE TABLE IF NOT EXISTS `message_ft_stopword` (
  `value` VARCHAR(30) NOT NULL
) ENGINE=InnoDB;

SET @mao_ft_sw := CONCAT(DATABASE(), '/message_ft_stopword');
SET SESSION innodb_ft_user_stopword_table = @mao_ft_sw;

ALTER TABLE `message`
  ADD FULLTEXT INDEX `ft_message_content` (`content`) WITH PARSER ngram,
  ALGORITHM=INPLACE, LOCK=SHARED;
