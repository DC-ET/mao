package cn.etarch.mao.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ServerConfigStoreTest {

    @Test
    public void savedWins() {
        assertEquals(
                "https://saved.example.com",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        "https://saved.example.com",
                        false,
                        "https://build.example.com",
                        "https://asset.example.com"
                )
        );
    }

    @Test
    public void invalidSavedFallsBackToBuildThenAsset() {
        assertEquals(
                "https://build.example.com",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        "ftp://bad",
                        false,
                        "https://build.example.com",
                        "https://asset.example.com"
                )
        );
        assertEquals(
                "https://asset.example.com",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        "https://saved.example.com/mao",
                        false,
                        "not a url",
                        "https://asset.example.com"
                )
        );
    }

    @Test
    public void buildTimeHttpDefaultsAreTrusted() {
        assertEquals(
                "http://10.0.0.8:8080",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        null,
                        false,
                        "http://10.0.0.8:8080",
                        "https://asset.example.com"
                )
        );
        assertEquals(
                "http://10.0.0.9:8080",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        null,
                        false,
                        "",
                        "http://10.0.0.9:8080"
                )
        );
    }

    @Test
    public void savedHttpIsIgnoredWhenNotAllowed() {
        assertEquals(
                "https://build.example.com",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        "http://10.0.0.8:8080",
                        false,
                        "https://build.example.com",
                        "https://asset.example.com"
                )
        );
    }

    @Test
    public void savedHttpIsUsedWhenAllowed() {
        assertEquals(
                "http://10.0.0.8:8080",
                ServerConfigStore.resolveEffectiveBaseUrl(
                        "http://10.0.0.8:8080",
                        true,
                        "https://build.example.com",
                        "https://asset.example.com"
                )
        );
    }

    @Test
    public void allInvalidFallsBackToOfficial() {
        assertEquals(
                "https://mao.etarch.cn",
                ServerConfigStore.resolveEffectiveBaseUrl(null, false, null, null)
        );
    }
}