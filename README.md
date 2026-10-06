# qWDTT OpenWrt

[![Release](https://img.shields.io/github/v/release/romankuznetsov/qwdtt-openwrt)](https://github.com/romankuznetsov/qwdtt-openwrt/releases/latest)
[![Release date](https://img.shields.io/github/release-date/romankuznetsov/qwdtt-openwrt)](https://github.com/romankuznetsov/qwdtt-openwrt/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/romankuznetsov/qwdtt-openwrt/total)](https://github.com/romankuznetsov/qwdtt-openwrt/releases)


qWDTT-клиент для роутеров OpenWrt с возможностью настройки через
UCI и веб-интерфейс LuCI, а также с отдельной страницей LuCI для
отслеживания состояния туннелей qWDTT.
Клиент поддерживает два режима работы - RAW и WireGuard.

Репозиторий также содержит обновляемый
[feed пакетов OpenWrt](https://romankuznetsov.github.io/qwdtt-openwrt/)
для удобной установки и обновления.

[SpaceNeuroX/qwdtt-openwrt](https://github.com/SpaceNeuroX/qwdtt-openwrt) -
исходный проект клиента qWDTT для OpenWrt, на основе которого создан этот
проект.

## Требования

- Роутер с OpenWrt 24.10 или 25.12.
- Свободное место на флеш-памяти: около 6 МБ на большинстве роутеров.
- Настроенный сервер qWDTT с включенным слушателем нужного режима: RAW
  (обычно UDP-порт 56003) или основным для WireGuard (обычно 56000).
- Данные подключения: адрес сервера, пароль и хеш звонка VK.

## Быстрый старт

Выполнить на роутере по SSH:

```sh
sh <(wget -O - https://raw.githubusercontent.com/romankuznetsov/qwdtt-openwrt/main/install.sh)
```

Скрипт определяет менеджер пакетов, добавляет feed и его ключ, устанавливает
`qwdtt-client`, `luci-proto-qwdtt` и русский перевод. Дальше - раздел
[Настройка](#настройка).

Без установки пакета с русским переводом `luci-i18n-qwdtt-ru`:

```sh
sh <(wget -O - https://raw.githubusercontent.com/romankuznetsov/qwdtt-openwrt/main/install.sh) -en
```

## Возможности

- Два режима: **RAW** - интерфейс сам является туннелем и получает адрес от
  сервера; **WireGuard** - интерфейс только ретранслирует локальный UDP-порт
  до WireGuard на сервере.
- Поддержка нескольких туннелей одновременно, в том числе к разным серверам.
- Настройка через LuCI на странице Network -> Interfaces.
- Страница состояния с возможностью проверки туннелей.

## Установка и обновление

Пакеты раздаются через подписанный
[feed](https://romankuznetsov.github.io/qwdtt-openwrt/): роутер проверяет
подпись индекса при обновлении списков пакетов. Подробно о feed, архитектурах
и ключах - [docs/custom-feed.md](docs/custom-feed.md). Сами пакеты и архивы с
ключами лежат также на странице [Releases](../../releases/latest).

Способы установки:

1. **Одной командой** по SSH - см. [Быстрый старт](#быстрый-старт).
2. **Вручную через менеджер пакетов**: добавить feed и его ключ, затем
   `opkg install` или `apk add` - см. [docs/custom-feed.md](docs/custom-feed.md).
3. **Через LuCI, без SSH**:
   1. Скачать со страницы [Releases](../../releases/latest) архив ключа:
      `qwdtt-apk-key.tar.gz` для 25.12 или `qwdtt-opkg-key.tar.gz` для 24.10.
      Восстановить его в System -> Backup / Flash Firmware -> Restore.
   2. В System -> Software -> Configuration добавить строку feed для своей
      архитектуры (адреса - на [странице feed](https://romankuznetsov.github.io/qwdtt-openwrt/))
      и нажать Update lists.
   3. Установить `qwdtt-client`, `luci-proto-qwdtt` и `luci-i18n-qwdtt-ru`.

**Обновление.** Новые версии приходят через тот же feed: кнопкой Upgrade в
System -> Software, повторным запуском `install.sh` или командой

```sh
opkg update && opkg upgrade qwdtt-client luci-proto-qwdtt luci-i18n-qwdtt-ru   # 24.10
apk update && apk upgrade qwdtt-client luci-proto-qwdtt luci-i18n-qwdtt-ru     # 25.12
```

Настройки туннелей хранятся в стандартном файле `/etc/config/network` и при обновлении
сохраняются.

## Настройка

Туннель - интерфейс в `/etc/config/network` с `option proto 'qwdtt'`. Его имя
служит и именем устройства, поэтому не длиннее 15 символов. Удобно называть
туннели `qwdtt0`, `qwdtt1` и так далее. Пароль и хеши звонка нельзя публиковать
или передавать посторонним.

<details>
<summary><b>RAW</b></summary>

**Через LuCI**

1. Network -> Interfaces -> Add new interface, протокол qWDTT, имя `qwdtt0`.
2. На вкладке qWDTT выбрать режим RAW и заполнить адрес сервера,
   идентификатор устройства, пароль и хеши. Хеши добавляются по одному
   кнопкой «+»; можно вставить и ссылку на звонок.
3. Галочка «Маршрутизировать трафик LAN-клиентов в этот туннель» уже включена,
   свободная таблица маршрутизации подставлена сама.
4. Save & Apply.

**Через UCI**

```sh
uci set network.qwdtt0=interface
uci set network.qwdtt0.proto='qwdtt'
uci set network.qwdtt0.ip4table='51820'
uci set network.qwdtt0.peer_host='IP_АДРЕС_СЕРВЕРА'
uci set network.qwdtt0.device_id='ИДЕНТИФИКАТОР_УСТРОЙСТВА'
uci set network.qwdtt0.password='ПАРОЛЬ'
uci add_list network.qwdtt0.hash='ХЕШ_ЗВОНКА'

uci set network.qwdtt0_rule=rule
uci set network.qwdtt0_rule.in='lan'
uci set network.qwdtt0_rule.lookup='51820'
uci set network.qwdtt0_rule.priority='9999'

uci commit network
ifup qwdtt0
```

Своя таблица (`ip4table`) обязательна: маршрут по умолчанию через туннель в
основной таблице увел бы в него и трафик самого клиента к VK.

</details>

<details>
<summary><b>WireGuard</b></summary>

В этом режиме интерфейс qWDTT ничего не везет сам: он ретранслирует локальный
порт до WireGuard на сервере. Трафик несет обычный интерфейс WireGuard,
направленный на `127.0.0.1` и этот порт.

**Через LuCI**

1. Создать интерфейс qWDTT, как для RAW, но выбрать режим WireGuard. Порт
   сервера по умолчанию 56000, «Порт локальной точки подключения» - 9000, у
   каждого туннеля свой. Save & Apply.
2. Скопировать содержимое `/var/run/qwdtt/qwdtt0.wg` (для этого нужен SSH).
3. Network -> Interfaces -> Add new interface, протокол WireGuard, имя `wg0`.
   На вкладке General Settings нажать Import configuration -> Load
   configuration и вставить скопированное: ключи, адрес и узел заполнятся
   сами.
4. На вкладке Advanced Settings задать Override IPv4 routing table,
   например `51821`. У узла включить Route Allowed IPs.
5. На вкладке Firewall Settings создать для `wg0` новую зону, затем в
   Network -> Firewall включить в ней Masquerading и разрешить forward из
   зоны `lan`.
6. В Network -> Routing -> IPv4 Rules добавить правило: Incoming interface
   `lan`, Table `51821`. Save & Apply.

**Через UCI**

```sh
uci set network.qwdtt0=interface
uci set network.qwdtt0.proto='qwdtt'
uci set network.qwdtt0.mode='wireguard'
uci set network.qwdtt0.listen_port='9000'
uci set network.qwdtt0.peer_host='IP_АДРЕС_СЕРВЕРА'
uci set network.qwdtt0.device_id='ИДЕНТИФИКАТОР_УСТРОЙСТВА'
uci set network.qwdtt0.password='ПАРОЛЬ'
uci add_list network.qwdtt0.hash='ХЕШ_ЗВОНКА'
uci commit network
ifup qwdtt0
```

Когда появится `/var/run/qwdtt/qwdtt0.wg`, перенести значения из него в
интерфейс WireGuard:

```sh
uci set network.wg0=interface
uci set network.wg0.proto='wireguard'
uci set network.wg0.private_key='PrivateKey_ИЗ_ФАЙЛА'
uci add_list network.wg0.addresses='Address_ИЗ_ФАЙЛА'
uci set network.wg0.mtu='1280'
uci set network.wg0.ip4table='51821'

uci set network.wg0_peer=wireguard_wg0
uci set network.wg0_peer.public_key='PublicKey_ИЗ_ФАЙЛА'
uci set network.wg0_peer.endpoint_host='127.0.0.1'
uci set network.wg0_peer.endpoint_port='9000'
uci set network.wg0_peer.persistent_keepalive='25'
uci add_list network.wg0_peer.allowed_ips='0.0.0.0/0'
uci set network.wg0_peer.route_allowed_ips='1'

uci set network.wg0_rule=rule
uci set network.wg0_rule.in='lan'
uci set network.wg0_rule.lookup='51821'
uci set network.wg0_rule.priority='9998'

uci set firewall.wg=zone
uci set firewall.wg.name='wg'
uci add_list firewall.wg.network='wg0'
uci set firewall.wg.input='DROP'
uci set firewall.wg.output='ACCEPT'
uci set firewall.wg.forward='REJECT'
uci set firewall.wg.masq='1'
uci set firewall.wg.mtu_fix='1'
uci set firewall.wg_lan=forwarding
uci set firewall.wg_lan.src='lan'
uci set firewall.wg_lan.dest='wg'

uci commit network
uci commit firewall
/etc/init.d/firewall reload
ifup wg0
```

</details>

## Проверка

- **Страница состояния** Status -> qWDTT: сервер,
  идентификатор устройства, сколько сессий работает, адрес и счетчики.
  Блок «Проверка туннеля» пингует адрес через сам туннель, а туннель в режиме
  WireGuard - через его интерфейс WireGuard.
- **Ошибки.** Если туннель не поднимается, причина отображается на странице
  интерфейса. После исправления нажать Restart на интерфейсе.
  Save & Apply сам туннель не перезапускает.
- **Логи** - в System -> System Log или по SSH. Рабочее подключение в режиме
  RAW пишет `RAW config received`, затем `TUN attached, traffic is flowing`.

```sh
logread -e qwdtt0
ip rule show
ip route show table 51820
```

## Лицензия

Этот проект распространяется под лицензией GNU General Public License v3.0.
