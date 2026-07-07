package cn.etarch.mao;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableAsync
@EnableScheduling
@MapperScan({"cn.etarch.mao.**.mapper", "cn.etarch.mao.**.activity"})
public class WorkbenchApplication {

    public static void main(String[] args) {
        SpringApplication.run(WorkbenchApplication.class, args);
    }
}
