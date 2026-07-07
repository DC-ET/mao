package cn.etarch.mao.config;

import cn.etarch.mao.audit.interceptor.AuditInterceptor;
import cn.etarch.mao.permission.interceptor.PermissionInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@RequiredArgsConstructor
public class WebMvcConfig implements WebMvcConfigurer {

    private final PermissionInterceptor permissionInterceptor;
    private final AuditInterceptor auditInterceptor;

    @Value("${app.file.upload-dir:$HOME/.mao/data/uploads}")
    private String uploadDir;

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // Serve uploaded files via /uploads/** — enables local dev access without Nginx.
        // In production Nginx handles this directly, this mapping acts as fallback.
        registry.addResourceHandler("/uploads/**")
                .addResourceLocations("file:" + (uploadDir.endsWith("/") ? uploadDir : uploadDir + "/"));
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true)
                .maxAge(3600);
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(permissionInterceptor)
                .addPathPatterns("/v1/**")
                .excludePathPatterns("/v1/auth/**");
        registry.addInterceptor(auditInterceptor)
                .addPathPatterns("/v1/**")
                .excludePathPatterns("/v1/auth/**");
    }
}
