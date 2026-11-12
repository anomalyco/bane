use anyhow::Result;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::OwnedSemaphorePermit;

/// Disk spool is anonymous (unlinked), bounded and owned by the connection. Allows
/// signing the digest before sending headers, without retaining the literal in RAM.
pub struct Upload {
    file: tokio::fs::File,
    hash: Sha256,
    pub remaining: usize,
    pub size: usize,
    _global: OwnedSemaphorePermit,
    _inbox: OwnedSemaphorePermit,
}
impl Upload {
    pub fn new(
        size: usize,
        global: OwnedSemaphorePermit,
        inbox: OwnedSemaphorePermit,
    ) -> Result<Self> {
        Ok(Self {
            file: tokio::fs::File::from_std(tempfile::tempfile()?),
            hash: Sha256::new(),
            size,
            remaining: size,
            _global: global,
            _inbox: inbox,
        })
    }
    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        anyhow::ensure!(data.len() <= self.remaining, "append exceeds reservation");
        self.file.write_all(data).await?;
        self.hash.update(data);
        self.remaining -= data.len();
        Ok(())
    }
    pub async fn finish(&mut self) -> Result<(reqwest::Body, String)> {
        anyhow::ensure!(self.remaining == 0, "incomplete append");
        self.file.rewind().await?;
        Ok((
            reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(
                self.file.try_clone().await?,
            )),
            hex::encode(self.hash.clone().finalize()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn an_upload_owns_capacity_until_complete_or_dropped() {
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(2));
        let mut upload = Upload::new(
            2,
            slots.clone().try_acquire_owned().unwrap(),
            slots.clone().try_acquire_owned().unwrap(),
        )
        .unwrap();
        assert_eq!(slots.available_permits(), 0);
        assert!(upload.finish().await.is_err());
        assert!(upload.write(b"abc").await.is_err());
        upload.write(b"a").await.unwrap();
        upload.write(b"b").await.unwrap();
        assert_eq!(
            upload.finish().await.unwrap().1,
            hex::encode(Sha256::digest(b"ab"))
        );
        drop(upload);
        assert_eq!(slots.available_permits(), 2);
    }
}
