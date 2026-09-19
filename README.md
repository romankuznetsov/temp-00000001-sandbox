# qWDTT OpenWrt

[![Release](https://img.shields.io/github/v/release/romankuznetsov/qwdtt-openwrt)](https://github.com/romankuznetsov/qwdtt-openwrt/releases/latest)
[![Release date](https://img.shields.io/github/release-date/romankuznetsov/qwdtt-openwrt)](https://github.com/romankuznetsov/qwdtt-openwrt/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/romankuznetsov/qwdtt-openwrt/total)](https://github.com/romankuznetsov/qwdtt-openwrt/releases)

RAW-IP клиент qWDTT для роутеров OpenWrt. Он поднимает интерфейс `qwdtt0` и
направляет через туннель IPv4-трафик устройств локальной сети. Сам роутер
сохраняет прямой доступ к WAN, поэтому соединения с VK TURN не зацикливаются.

Поддерживается только RAW-IP. WireGuard и SOCKS в этой сборке намеренно не
включены.

## История появления

Клиент qWDTT и сама идея принадлежат проекту
[SpaceNeuroX/qwdtt-openwrt](https://github.com/SpaceNeuroX/qwdtt-openwrt) -
без него этого репозитория бы не было.

Этот форк изначально создавался для личного пользования как дополнение к
исходному проекту. В какой-то момент форк был доработан, приведен в нормальный
вид и выложен для публичного использования - на случай, если кому-то окажется
полезным.

Также буду рад правкам, улучшениям и багфиксам.

## Отличия от исходного проекта

Этот проект добавляет графический интерфейс LuCI для настройки qWDTT-клиента
и упрощает его установку и обновление стандартными средствами управления
пакетами OpenWrt.

В исходном проекте клиент устанавливают вручную: скачивают tar.gz под свою
архитектуру и распаковывают. Здесь он собран пакетами OpenWrt и раздается
через feed.

- **Страница в LuCI** - Services -> qWDTT, с русским переводом. В исходном
  проекте настраивают по SSH, правкой файла.
- **Все настройки в UCI.** В исходном проекте `/etc/config/qwdtt` хранит
  только `enabled` и путь к `/etc/qwdtt/config.json`, который правят руками.
  Здесь каждая настройка - опция UCI, а init-скрипт собирает из них аргументы
  запуска. Отсюда и страница в LuCI: она умеет править UCI, а не произвольный
  JSON.
- **Стандартные пакеты OpenWrt** - `.ipk` на 24.10, `.apk` на 25.12. Работают
  штатные `opkg install` и `apk add`, зависимости подтягиваются сами.
- **Обновление вместо переустановки.** `/etc/config/qwdtt` объявлен conffile,
  поэтому настройки переживают установку новой версии.
- **Подписанный feed.** Индекс подписан `usign` на 24.10 и ключом проекта на
  25.12. Роутер проверяет подпись при `update`, а каждый пакет - по хешам из
  индекса.
- **Сборка под 34 архитектуры пакетов**, в исходном проекте было только
  четыре самых распространенных. Тарболлы тоже остались: x86_64, aarch64,
  armv7, mipsel, mips.

Список будет дополняться.

## Состав пакетов

Четыре пакета. По отдельности они обычно не нужны: `install.sh` ставит все
сам, зависимости подтянет менеджер пакетов.

- `qwdtt-client` - клиент на Go. Создает TUN-интерфейс (по умолчанию `qwdtt0`)
  и заводит маршрут и правило policy routing, по которым трафик уходит в
  туннель. Одна копия клиента - один туннель.
- `qwdtt` - сервис procd `/etc/init.d/qwdtt`, конфиг UCI `/etc/config/qwdtt`
  и команда `/usr/bin/qwdtt` для запуска, остановки и диагностики.
- `luci-app-qwdtt` (не обязателен для работы) - приложение LuCI для
  управления и настройки клиента. Находится в Services -> qWDTT.
- `luci-i18n-qwdtt-ru` (не обязателен для работы) - пакет с русским переводом
  интерфейса приложения.

## Что понадобится

- Роутер с OpenWrt 24.10 или 25.12.
- VPS-сервер qWDTT с включенным RAW-слушателем. Обычно это UDP-порт `56003`.
- Данные подключения: адрес сервера, пароль и хеш звонка VK.

## Установка

Два способа установить пакеты. Настройка после установки одинаковая - см.
раздел "Настройка".

### Способ 1: одной командой (SSH)

Подключитесь к роутеру по SSH по его IP-адресу, например 192.168.1.1:

```sh
ssh root@192.168.1.1
```

и выполните:

```sh
wget -qO- https://raw.githubusercontent.com/romankuznetsov/qwdtt-openwrt/main/install.sh | sh
```

Скрипт сам определяет менеджер пакетов, добавляет подписанный feed и его ключ
доверия, затем ставит `qwdtt-client`, `qwdtt`, `luci-app-qwdtt` и зависимости.

### Способ 2: через LuCI (без SSH)

Полностью через веб-интерфейс. Порядок зависит от менеджера пакетов: `apk` на
OpenWrt 25.12, `opkg` на 24.10.

Подробно о feed, ключах, архитектурах и типовых ошибках -
[docs/custom-feed.md](docs/custom-feed.md).

#### OpenWrt 25.12 (apk)

Отдельные `.apk` не подписаны, поэтому доверие дает ключ feed, а не загрузка
файлов пакетов - загруженный через LuCI пакет ставится недоверенным.

1. Установите ключ доверия. Скачайте `qwdtt-apk-key.tar.gz` со страницы
   [Releases](../../releases/latest) и восстановите архив в
   System -> Backup / Flash Firmware -> "Restore". Он кладет публичный ключ в
   `/etc/apk/keys` - без него feed недоверенный.
2. Добавьте feed. В System -> Software -> Configuration допишите строку для
   своей архитектуры (полный список - на
   [странице feed](https://romankuznetsov.github.io/qwdtt-openwrt/)), например
   для `aarch64_cortex-a53`:

   ```
   https://romankuznetsov.github.io/qwdtt-openwrt/releases/25.12/aarch64_cortex-a53/packages.adb
   ```

   Сохраните, затем нажмите "Update lists…".
3. В System -> Software установите пакеты `qwdtt-client`, `qwdtt` и
   `luci-app-qwdtt`.

#### OpenWrt 24.10 (opkg)

Порядок тот же, что и для 25.12, но feed и ключ - свои: opkg читает индекс
`Packages` и проверяет его подпись через `usign`.

1. Установите ключ доверия. Скачайте `qwdtt-opkg-key.tar.gz` со страницы
   [Releases](../../releases/latest) и восстановите архив в
   System -> Backup / Flash Firmware -> "Restore". Он кладет публичный ключ в
   `/etc/opkg/keys` под именем его key id.
2. Добавьте feed. В System -> Software -> Configuration допишите строку для
   своей архитектуры, например для `mipsel_24kc`:

   ```
   src/gz qwdtt https://romankuznetsov.github.io/qwdtt-openwrt/releases/24.10/mipsel_24kc
   ```

   Сохраните, затем нажмите "Update lists…".
3. В System -> Software установите пакеты `qwdtt-client`, `qwdtt` и
   `luci-app-qwdtt`.

## Настройка

Все настройки хранятся в UCI (`/etc/config/qwdtt`) и правятся через LuCI
(Services -> qWDTT) или командой `uci`. Значения по умолчанию задает
[`qwdtt/files/qwdtt.config`](qwdtt/files/qwdtt.config).

Одна секция - один туннель, и они работают одновременно. В поставке есть
секция `main`; о том, как добавить вторую, написано в
[docs/multi-tunnel.md](docs/multi-tunnel.md).

`lan_interface` по умолчанию - `br-lan`. Если в вашей сборке OpenWrt LAN
называется иначе, поменяйте это поле. Зона `qwdtt` в firewall принимает
устройства по шаблону `qwdtt+`, поэтому любое имя, которое начинается с
`qwdtt`, попадает в нее само; имя с другим началом нужно добавить в зону
вручную.

1. Задайте адрес сервера, пароль и хеши звонка - через LuCI
   (Services -> qWDTT -> Settings) или через UCI:

   ```sh
   uci set qwdtt.main.peer_host='IP_АДРЕС_СЕРВЕРА'
   uci set qwdtt.main.peer_port='56003'
   uci set qwdtt.main.password='ПАРОЛЬ'
   uci add_list qwdtt.main.hash='ХЕШ_ЗВОНКА'
   uci commit qwdtt
   ```

   Пароль и хеш нельзя публиковать или отправлять посторонним.

2. Включите автозапуск и запустите туннель - кнопкой Restart в его строке на
   странице Services -> qWDTT в LuCI или из шелла:

   ```sh
   /etc/init.d/qwdtt enable
   /usr/bin/qwdtt -s main start
   ```

Остановить один туннель или все сразу:

```sh
/usr/bin/qwdtt -s main stop
/etc/init.d/qwdtt stop
```

`-s` меняет и флаг автозапуска этой секции; без него команда действует на
сервис целиком и флаги не трогает.

## Проверка

Логи подключения - все туннели или один:

```sh
logread -e qwdtt
logread -e qwdtt-main
```

Рабочее подключение пишет `RAW-конфиг получен`, затем `TUN подключён, трафик
пошёл`. Проверить интерфейс и правило маршрутизации можно так:

```sh
ip addr show qwdtt0
ip rule show
ip route show table 51820
```

Проверка создания TUN без данных VK и сервера:

```sh
/usr/bin/qwdtt-client -rawtun-self-test 10.70.0.2
```
