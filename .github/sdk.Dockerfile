ARG ARCH
FROM ghcr.io/openwrt/sdk:$ARCH

# Everything qwdtt-client depends on, built once here instead of in every
# per-architecture job. iproute2 alone drags in libbpf, elfutils, libnftnl and
# iptables, and compiling that chain was four of the eight minutes such a job
# took. kmod-tun is absent because the SDK ships it prebuilt.
#
# feeds and defconfig are done here for the same reason: gh-action-sdk repeats
# both at run time, but against an already updated tree they cost seconds.
#
# Adding a DEPENDS to qwdtt-client means adding it here and re-baking, or the
# job compiles it at run time again and the image only half helps.
RUN ./scripts/feeds update -a \
	&& ./scripts/feeds install -a \
	&& make defconfig \
	&& make -j"$(nproc)" package/iproute2/compile package/ca-certificates/compile

# No ENTRYPOINT on purpose. gh-action-sdk builds its own image FROM this one
# and adds the entrypoint itself; that is what the CONTAINER variable selects.
