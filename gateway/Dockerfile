FROM rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core core
COPY mailgw mailgw
RUN cargo build --release --locked --bin mailgw && strip target/release/mailgw
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/target/release/mailgw /mailgw
ENV MAILGW_BIND=0.0.0.0
# Keep glibc from raising its mmap threshold after multi-MiB FETCH buffers
# are freed. Return those mappings to the OS; bound the smaller thread heaps.
ENV GLIBC_TUNABLES=glibc.malloc.mmap_threshold=131072:glibc.malloc.arena_max=2
EXPOSE 143 993 465 587 8080
ENTRYPOINT ["/mailgw"]
