FROM httpd:2.4-alpine@sha256:070da7661f0be8a05430b2c125c0cde9e53176b4048c813024021969a0e3893c
# The upstream Alpine image omits the DBM plugin required by mod_dav_fs locks.
RUN apk add --no-cache apr-util-dbm_gdbm=1.6.4-r0
