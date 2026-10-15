use super::*;
#[derive(Clone, Debug)]
pub struct Host {
    pub origin: String,
    pub callback: String,
    pub trust_proxy: bool,
}
impl Host {
    pub fn new(origin: String, callback: String) -> Result<Self> {
        let public = url::Url::parse(&origin).map_err(|_| Error::Validation)?;
        if public.path() != "/"
            || public.query().is_some()
            || public.fragment().is_some()
            || !public.username().is_empty()
            || public.password().is_some()
            || !(public.scheme() == "https"
                || public.scheme() == "http" && public.host_str() == Some("127.0.0.1"))
        {
            return Err(Error::Validation);
        }
        let local = url::Url::parse(&callback).map_err(|_| Error::Validation)?;
        if local.scheme() != "http"
            || local.host_str() != Some("127.0.0.1")
            || local.path() != "/auth/callback"
            || local.query().is_some()
            || local.fragment().is_some()
            || !local.username().is_empty()
            || local.password().is_some()
        {
            return Err(Error::Validation);
        }
        Ok(Self {
            origin: public.origin().ascii_serialization(),
            callback: local.to_string(),
            trust_proxy: false,
        })
    }
    pub fn authority(url: &str) -> Result<String> {
        let url = url::Url::parse(url).map_err(|_| Error::Validation)?;
        Ok(match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().ok_or(Error::Validation)?),
            None => url.host_str().ok_or(Error::Validation)?.to_owned(),
        })
    }
    pub fn accepts(&self, host: &str, path: &str) -> bool {
        Self::authority(&self.origin).is_ok_and(|s| s == host)
            || (path == "/auth/callback"
                && Self::authority(&self.callback).is_ok_and(|s| s == host))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_origin_and_tunnel_callback_have_separate_authority() {
        let host = Host::new(
            "https://apps.example.test".into(),
            "http://127.0.0.1:1455/auth/callback".into(),
        )
        .unwrap();
        assert!(host.accepts("apps.example.test", "/api/apps"));
        assert!(host.accepts("127.0.0.1:1455", "/auth/callback"));
        assert!(!host.accepts("127.0.0.1:1455", "/api/apps"));
        assert!(!host.accepts("evil.example.test", "/auth/callback"));
        assert!(Host::new("http://apps.example.test".into(), host.callback).is_err());
    }
}
