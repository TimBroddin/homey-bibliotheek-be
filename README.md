# Bibliotheek.be for Homey

Track your Belgian public library loans from bibliotheek.be and get notified before they expire.

> **Note**: This is a Homey port of the [bibliotheek.be Home Assistant integration](https://github.com/myTselection/bibliotheek_be) by myTselection.

## Features

- **Loan Tracking**: See how many days remaining on all your loans
- **Multiple Users**: Support for family accounts with multiple library cards
- **Flow Integration**: Create automations based on loan status
- **Auto-Extend**: Automatically extend loans before they expire

## Installation

1. Install from the Homey App Store
2. Add a device and enter your bibliotheek.be credentials
3. Create Flows to receive notifications or auto-extend loans

## Flow Cards

### Triggers (When...)

- **Loan is expiring soon**: Triggers when any loan drops below a specified number of days
- **A loan is overdue**: Triggers when any loan becomes overdue
- **Minimum days remaining changed**: Triggers when the minimum days remaining across all loans changes

### Conditions (And...)

- **Loans are expiring within X days**: Check if any loans are expiring soon
- **All loans can be extended**: Check if all current loans can be extended
- **There are overdue loans**: Check if there are any overdue loans

### Actions (Then...)

- **Extend all eligible loans**: Automatically extend all loans below a threshold
- **Refresh library data**: Force an immediate data refresh

## Example Flows

### Send notification when books expire soon

```
WHEN: Loan is expiring soon (7 days)
THEN: Send push notification "[[Book Title]] expires in [[Days Left]] days at [[Library]]"
```

### Auto-extend all loans

```
WHEN: Minimum days remaining changed
AND: Loans are expiring within 7 days
AND: All loans can be extended
THEN: Extend loans with 7 or fewer days remaining
```

## Privacy

Your bibliotheek.be credentials are stored locally on your Homey and are only used to communicate with bibliotheek.be.

## Source Code

https://github.com/timbroddin/homey-bibliotheek-be

## License

GPL-3.0
