FROM composer:2@sha256:c7f68260503e3c1f0ece10bdbe84519fd98d48ba091f2c02f16ea94a7faae337
WORKDIR /server
COPY composer.json composer.lock server.php ./
RUN composer install --no-dev --no-interaction --no-progress
CMD ["php", "-S", "0.0.0.0:8080", "server.php"]
