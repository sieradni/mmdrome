<?php
require __DIR__ . '/vendor/autoload.php';
$server = new Sabre\DAV\Server(new Sabre\DAV\FS\Directory('/data'));
$server->setBaseUri('/');
$server->exec();
