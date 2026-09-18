ARG ARCH
FROM ghcr.io/openwrt/sdk:$ARCH

# The release containers carry the SDK unpacked, but they also carry the
# setup.sh that the snapshot containers need to fetch theirs, and gh-action-sdk
# runs it whenever the file is present: every job downloads the same tarball
# again - two minutes for 24.10.8, four for 25.12.5 - and untars it over the
# tree. That is what makes the rest of this file worth writing, and it is also
# what silently undid it: the tarball restores staging_dir/host/bin/gcc as the
# dangling link it ships, while the marker saying the host tools were already
# checked is not in the tarball and survives, so nothing relinks it and the
# first host tool to compile dies on a path that is right there.
RUN rm -f setup.sh

# Everything qwdtt-client depends on, compiled once here instead of in every
# per-architecture job. iproute2 alone drags in libbpf, elfutils, libnftnl and
# iptables, and compiling that chain was four of the eight minutes such a job
# took. kmod-tun is absent because the SDK ships it prebuilt.
#
# Named packages, not `feeds install -a`: installing every package from every
# feed puts thousands of them in the tree, and defconfig then dies with
# "recursive dependency detected" long before anything is compiled.
#
# The feeds are deleted again in the same layer. gh-action-sdk points feeds.conf
# at the GitHub mirrors, and scripts/feeds replaces any feed whose URL moved, so
# they would be re-cloned at run time regardless - forty seconds, against two
# gigabytes of image to pull first. What matters is under build_dir and
# staging_dir, and the symlinks in package/feeds resolve again once the run has
# cloned the feeds back.
#
# Adding a DEPENDS to qwdtt-client means adding it here and re-baking, or the
# job compiles it at run time again and the image only half helps.
RUN ./scripts/feeds update -a \
	&& ./scripts/feeds install iproute2 ca-certificates \
	&& make defconfig \
	&& make -j"$(nproc)" package/iproute2/compile package/ca-certificates/compile \
	&& rm -rf feeds

# No ENTRYPOINT on purpose. gh-action-sdk builds its own image FROM this one
# and adds the entrypoint itself; that is what the CONTAINER variable selects.
