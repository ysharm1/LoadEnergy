# Requirements Document

## Introduction

Load Energy is a Phoenix-first commercial diesel load board that connects buyers (job sites and small fleets) with licensed local diesel deliverers (suppliers). A buyer posts a fuel request specifying gallons, product type, delivery method, location pin, and window. Nearby approved suppliers who are marked Open or Limited quote a short-lived landed price per gallon with a 1–8 hour hold. The buyer accepts one offer, which creates the Order; the supplier hauls fuel from existing Phoenix terminals and delivers, then records the Bill of Lading (BOL) gallons. Load Energy earns a commission of $0.02 per delivered BOL gallon, invoiced to the winning supplier company, with the first two completed wins per supplier waived.

Load Energy is a marketplace ledger, not a transportation management system and not a payment processor. In v1 it does not buy fuel, own trucks, process the customer's fuel payment, transfer title, require truck GPS, auto-dispatch, use ML pricing as a product, handle gasoline / DEF / cardlock, or handle multi-state tax. Supplier license verification is an offline Admin process against the ADOT supplier list; the system does not scrape or certify licenses.

The product ships as a mobile-first progressive web application (PWA) supporting three roles: Buyer (superintendent / fleet) optimized for phone use in the field, Supplier (dispatcher) optimized for phone and laptop use, and Admin (the marketplace operator) who approves suppliers, sets each supplier's operating location and service radius, configures the pilot geofence, can enter deals arranged off-app (concierge), marks commission invoices paid, and monitors commission due. The pilot targets density in the Phoenix SW Valley. Pilot success is 20 delivered loads in 60 days, including concierge orders.

## Glossary

- **Load_Energy_System**: The overall marketplace platform being specified, comprising the API, data store, notification service, and web client.
- **User**: An individual account holder who authenticates to the platform and belongs to a Company. A User has a required phone number and an optional email address.
- **Company**: A business entity registered on the platform, typed as either a Buyer company or a Supplier company.
- **Buyer**: A User belonging to a Buyer Company (e.g., a job site superintendent or fleet manager) who posts Requests and accepts Offers.
- **Supplier**: A User belonging to a Supplier Company (e.g., a dispatcher) who is a licensed diesel deliverer and submits Offers.
- **Admin**: A User who operates the marketplace, with authority to approve Supplier Companies, set a Supplier Company's Operating_Location and Service_Radius, configure the Pilot_Geofence, enter Concierge_Orders, mark Commission_Invoices paid, and view commission owed.
- **Supplier_Approval_Status**: A Supplier Company's onboarding state, either Approved or Pending, controlling whether the Company may receive RFQs and submit Offers. License verification is performed offline by an Admin against the ADOT supplier list before approval.
- **Site**: A physical location belonging to a Buyer Company, defined by a geographic pin (latitude/longitude), used as a delivery destination.
- **Request**: A buyer-posted diesel load specification (also called an RFQ) including gallons, Product_Type, Delivery_Method, location pin, Delivery_Window, optional notes, and a Request_Status.
- **RFQ**: Request For Quote; a synonym for a Request as seen from the Supplier's perspective.
- **Request_Status**: The state of a Request, one of Open, Accepted, Cancelled, or Expired.
- **Product_Type**: The diesel product being requested, either ULSD (ultra-low-sulfur on-road diesel) or Dyed (off-road dyed diesel).
- **Delivery_Method**: How fuel is delivered, either Wet_Hose (pumped directly into equipment) or Yard_Tank (delivered to an on-site tank).
- **Delivery_Window**: The time period during which delivery is requested (e.g., Today or Tomorrow_AM), with a defined window end time.
- **Pilot_Geofence**: An Admin-configured bounding box (min/max latitude and longitude) covering the Phoenix SW Valley pilot area. A Request whose location pin falls outside the Pilot_Geofence is rejected.
- **Operating_Location**: A Supplier Company's origin coordinate (latitude/longitude), set by an Admin, used as the origin for Service_Radius matching.
- **Service_Radius**: The geographic radius in miles around a Supplier Company's Operating_Location within which the Supplier receives RFQs, configured by an Admin.
- **Offer**: A supplier-submitted quote on a Request, consisting of a Landed_Price per gallon, an optional ETA, and a hold duration in hours after which the Offer expires.
- **Landed_Price**: The all-in price per gallon quoted by a Supplier, expressed in US dollars per gallon.
- **Hold_Hours**: The number of hours an Offer remains acceptable after creation, constrained to the inclusive range 1 to 8.
- **Offer_Expiry**: The timestamp after which an Offer is no longer valid for acceptance, computed as the Offer creation time plus Hold_Hours.
- **Order**: The record created when a Buyer accepts an Offer (or an Admin enters a Concierge_Order), tracking the fulfillment lifecycle.
- **Order_Status**: The state of an Order, one of Accepted, En_Route, or Delivered.
- **Delivery**: The fulfillment record attached to an Order, containing BOL_Gallons, a ticket number, and an optional ticket photo. An Order has at most one Delivery.
- **BOL_Gallons**: The Bill of Lading gallons actually delivered, recorded on the Delivery, used as the basis for commission.
- **Supplier_Status**: A Supplier Company's live availability, one of Open, Limited, or Closed.
- **Commission_Invoice**: An invoice issued by the Load_Energy_System to a winning Supplier Company for a Delivered Order, with an amount, a waived flag, and a payment status.
- **Commission_Rate**: The take rate charged per delivered BOL gallon, $0.02 for the pilot.
- **Payment_Status**: A Commission_Invoice's payment state, either Unpaid or Paid.
- **Waived_Win**: A Supplier Company's completed (Delivered) Order that carries a zero-dollar commission; a Supplier Company's first two completed wins are Waived_Wins to encourage adoption.
- **Concierge_Order**: An Order entered directly by an Admin to record a deal arranged off-app, capturing the Buyer Company, winning Supplier Company, and delivered gallons.
- **Audit_Log**: An append-only record of significant marketplace actions, each row capturing the acting User (where any), entity ids, prior/new values where relevant, and a timestamp.
- **Notification_Service**: The component responsible for sending SMS (required) and email (where on file) messages on marketplace events.

## Requirements

### Requirement 1: Authentication, User Identity, and Company Roles

**User Story:** As a user, I want to authenticate and be associated with my company, role, and contact details, so that I only see and perform actions appropriate to a buyer, supplier, or admin and can be reached about my loads.

#### Acceptance Criteria

1. WHEN a User submits valid credentials, THE Load_Energy_System SHALL authenticate the User and establish an authenticated session.
2. IF a User submits invalid credentials, THEN THE Load_Energy_System SHALL reject the authentication attempt and return an authentication error.
3. THE Load_Energy_System SHALL associate each User with exactly one Company.
4. THE Load_Energy_System SHALL assign each User a role of Buyer, Supplier, or Admin.
5. WHEN a User is created with a phone number in E.164 (or equivalent) form, THE Load_Energy_System SHALL store the phone number with the User.
6. IF a User is created without a phone number, THEN THE Load_Energy_System SHALL reject the creation and return a validation error.
7. WHERE a User provides an email address, THE Load_Energy_System SHALL store the email address with the User.
8. WHEN an authenticated User of a given role accesses the application, THE Load_Energy_System SHALL present the interface for that User's role.
9. IF an authenticated User attempts an action reserved for a role the User does not hold, THEN THE Load_Energy_System SHALL deny the action and return an authorization error.

### Requirement 2: Site Management

**User Story:** As a buyer, I want to manage delivery sites for my company, so that I can quickly reuse locations when posting requests.

#### Acceptance Criteria

1. WHEN a Buyer submits a Site with a name and a geographic pin, THE Load_Energy_System SHALL create the Site and associate it with the Buyer's Company.
2. THE Load_Energy_System SHALL store each Site's geographic pin as a latitude and longitude coordinate pair.
3. WHEN a Buyer requests the list of Sites, THE Load_Energy_System SHALL return only Sites belonging to the Buyer's Company.
4. IF a Buyer submits a Site with a latitude outside the range -90 to 90 or a longitude outside the range -180 to 180, THEN THE Load_Energy_System SHALL reject the Site and return a validation error.

### Requirement 3: Create Fuel Request

**User Story:** As a buyer / superintendent, I want to post a fuel request in under 60 seconds from my phone, so that I can get diesel delivered to my job site quickly.

#### Acceptance Criteria

1. WHEN a Buyer submits a Request with gallons, Product_Type, Delivery_Method, a location pin within the Pilot_Geofence, and a Delivery_Window, THE Load_Energy_System SHALL create the Request with an initial Request_Status of Open.
2. THE Load_Energy_System SHALL accept a Product_Type of either ULSD or Dyed on a Request.
3. THE Load_Energy_System SHALL accept a Delivery_Method of either Wet_Hose or Yard_Tank on a Request.
4. THE Load_Energy_System SHALL accept a Delivery_Window of either Today or Tomorrow_AM on a Request.
5. IF a Buyer submits a Request with gallons less than or equal to zero, THEN THE Load_Energy_System SHALL reject the Request and return a validation error.
6. IF a Buyer submits a Request whose location pin falls outside the Pilot_Geofence, THEN THE Load_Energy_System SHALL reject the Request and return a geofence error.
7. WHERE a Buyer provides notes on a Request, THE Load_Energy_System SHALL store the notes with the Request.
8. THE Load_Energy_System SHALL associate each created Request with the Buyer who created it and that Buyer's Company.
9. WHEN a Buyer requests the list of their loads, THE Load_Energy_System SHALL return the Open Requests and the Orders belonging to the Buyer's Company.

### Requirement 4: Pilot Geofence and Supplier Radius Matching

**User Story:** As a supplier / dispatcher, I want to see only in-area requests within my service radius, so that I quote loads I can actually deliver.

#### Acceptance Criteria

1. THE Load_Energy_System SHALL make a Request visible to a Supplier Company only WHERE all of the following hold: the Supplier Company's Supplier_Approval_Status is Approved, the Supplier_Status is Open or Limited, the Request's location pin is within the Supplier Company's Service_Radius of its Operating_Location, and the Request_Status is Open.
2. THE Load_Energy_System SHALL compute the distance between a Request's location pin and a Supplier Company's Operating_Location using great-circle distance.
3. WHEN a Supplier requests their RFQ inbox, THE Load_Energy_System SHALL return only Requests that satisfy the matching visibility rule.
4. IF a Request's location pin lies outside a Supplier Company's Service_Radius, THEN THE Load_Energy_System SHALL exclude the Request from that Supplier Company's RFQ inbox.
5. THE Load_Energy_System SHALL exclude Cancelled and Expired Requests from every Supplier Company's RFQ inbox.
6. WHILE a Supplier Company's Supplier_Status is Closed, THE Load_Energy_System SHALL exclude that Supplier Company from RFQ matching.
7. THE Load_Energy_System SHALL use the Operating_Location and Service_Radius values configured by an Admin for each Supplier Company.

### Requirement 5: Supplier Availability Status

**User Story:** As a supplier / dispatcher, I want to toggle my availability between Open, Limited, and Closed, so that I control whether I receive and can quote on requests.

#### Acceptance Criteria

1. THE Load_Energy_System SHALL assign each Supplier Company a Supplier_Status of Open, Limited, or Closed.
2. WHEN a Supplier changes their Supplier_Status, THE Load_Energy_System SHALL persist the new Supplier_Status.
3. WHILE a Supplier Company's Supplier_Status is Open or Limited, THE Load_Energy_System SHALL include that Supplier Company in RFQ matching for Requests within the Supplier Company's Service_Radius.
4. IF a Supplier whose Supplier_Status is Closed attempts to submit an Offer, THEN THE Load_Energy_System SHALL reject the Offer and return an error.
5. IF a Supplier whose Supplier_Approval_Status is Pending attempts to submit an Offer, THEN THE Load_Energy_System SHALL reject the Offer and return an error.

### Requirement 6: Submit Offer

**User Story:** As a supplier / dispatcher, I want to quote a landed price per gallon with a 1–8 hour hold, so that the buyer can accept my offer before it expires.

#### Acceptance Criteria

1. WHEN a Supplier submits an Offer on an Open Request with a Landed_Price and a Hold_Hours value, THE Load_Energy_System SHALL create the Offer associated with the Request and the Supplier's Company.
2. THE Load_Energy_System SHALL compute the Offer_Expiry as the Offer creation time plus Hold_Hours.
3. WHERE a Supplier provides an ETA on an Offer, THE Load_Energy_System SHALL store the ETA with the Offer.
4. IF a Supplier submits an Offer with a Landed_Price less than or equal to zero, THEN THE Load_Energy_System SHALL reject the Offer and return a validation error.
5. IF a Supplier submits an Offer with a Hold_Hours value outside the inclusive range 1 to 8, THEN THE Load_Energy_System SHALL reject the Offer and return a validation error.
6. WHEN a Buyer requests the Offers for their Request, THE Load_Energy_System SHALL return each Offer's Supplier name, Landed_Price, ETA, and Offer_Expiry.

### Requirement 7: Offer Expiry

**User Story:** As a buyer, I want offers to expire after their hold duration, so that I only accept prices that suppliers still honor.

#### Acceptance Criteria

1. WHILE the current time is before an Offer's Offer_Expiry, THE Load_Energy_System SHALL treat the Offer as active and acceptable.
2. WHEN the current time reaches or passes an Offer's Offer_Expiry, THE Load_Energy_System SHALL treat the Offer as expired.
3. IF a Buyer attempts to accept an Offer whose Offer_Expiry has passed, THEN THE Load_Energy_System SHALL reject the acceptance and return an expiry error.
4. WHEN a Buyer requests the Offers for their Request, THE Load_Energy_System SHALL indicate for each Offer whether the Offer is active or expired.

### Requirement 8: Accept Offer and Create Order

**User Story:** As a buyer, I want to accept exactly one offer with a single tap, so that I lock in a supplier and price for my load.

#### Acceptance Criteria

1. WHEN a Buyer accepts an active Offer on their Open Request, THE Load_Energy_System SHALL create an Order with an initial Order_Status of Accepted, linking the Request, the accepted Offer, and the winning Supplier Company.
2. WHEN an Order is created from an accepted Offer, THE Load_Energy_System SHALL set the Request_Status to Accepted.
3. WHEN a Buyer accepts an Offer on a Request, THE Load_Energy_System SHALL void every other active Offer on that same Request.
4. IF a Buyer attempts to accept an Offer on a Request whose Request_Status is not Open, THEN THE Load_Energy_System SHALL reject the acceptance and return an error.
5. IF a User not belonging to the owning Buyer's Company attempts to accept an Offer on a Request, THEN THE Load_Energy_System SHALL deny the acceptance and return an authorization error.
6. IF a Supplier whose Supplier_Status is Closed owns an Offer, THEN THE Load_Energy_System SHALL exclude that Offer from acceptance and reject any attempt to accept it.
7. WHEN an Order is created, THE Load_Energy_System SHALL make the Order visible to the winning Supplier Company as a won order.

### Requirement 9: Cancel and Expire Requests

**User Story:** As a buyer, I want to cancel a request I no longer need, and I want stale requests to expire automatically, so that suppliers do not quote loads that are no longer live.

#### Acceptance Criteria

1. WHEN a Buyer cancels their Request whose Request_Status is Open, THE Load_Energy_System SHALL set the Request_Status to Cancelled and void every active Offer on that Request.
2. IF a Buyer attempts to cancel a Request whose Request_Status is not Open, THEN THE Load_Energy_System SHALL reject the cancellation and return an error.
3. WHEN the Delivery_Window of a Request has ended AND the Request_Status is still Open, THE Load_Energy_System SHALL set the Request_Status to Expired and void every remaining active Offer on that Request.
4. THE Load_Energy_System SHALL exclude Requests whose Request_Status is Cancelled or Expired from Supplier RFQ inboxes.
5. IF a User not belonging to the owning Buyer's Company attempts to cancel a Request, THEN THE Load_Energy_System SHALL deny the cancellation and return an authorization error.

### Requirement 10: Order Lifecycle and Status

**User Story:** As a buyer and as a supplier, I want to track an order through its status stages, so that both parties know where the delivery stands.

#### Acceptance Criteria

1. THE Load_Energy_System SHALL represent Order_Status as one of Accepted, En_Route, or Delivered.
2. WHEN a Supplier marks a won Order as en route, THE Load_Energy_System SHALL set the Order_Status to En_Route.
3. WHEN a Supplier marks a won Order as delivered, THE Load_Energy_System SHALL set the Order_Status to Delivered.
4. THE Load_Energy_System SHALL allow Order_Status to advance only in the forward sequence Accepted then En_Route then Delivered, and SHALL allow recording a Delivery directly from Accepted.
5. IF a request to change Order_Status would move the status backward in the sequence, THEN THE Load_Energy_System SHALL reject the change and return an error.
6. WHEN a Buyer views an Order, THE Load_Energy_System SHALL return the current Order_Status.

### Requirement 11: Delivery and BOL Recording

**User Story:** As a supplier / dispatcher, I want to record the delivered BOL gallons and ticket number, so that the delivery is documented and commission can be calculated.

#### Acceptance Criteria

1. WHEN a Supplier records a Delivery on a won Order with BOL_Gallons and a ticket number, THE Load_Energy_System SHALL create the Delivery associated with the Order and set the Order_Status to Delivered.
2. THE Load_Energy_System SHALL allow at most one Delivery per Order.
3. IF a Supplier records a Delivery on an Order that already has a Delivery, THEN THE Load_Energy_System SHALL reject the Delivery and return an error.
4. IF a Supplier records a Delivery with BOL_Gallons less than or equal to zero, THEN THE Load_Energy_System SHALL reject the Delivery and return a validation error.
5. IF a Supplier records a Delivery without a ticket number, THEN THE Load_Energy_System SHALL reject the Delivery and return a validation error.
6. WHERE a Supplier provides a ticket photo, THE Load_Energy_System SHALL store the ticket photo with the Delivery.
7. IF a User other than the winning Supplier Company attempts to record a Delivery on an Order, THEN THE Load_Energy_System SHALL deny the action and return an authorization error.

### Requirement 12: Commission Invoicing and Payment

**User Story:** As the marketplace operator, I want to invoice the winning supplier a commission on delivered gallons and track payment, so that Load Energy earns revenue only when fuel is delivered and I can see what is owed.

#### Acceptance Criteria

1. WHEN an Order reaches Order_Status Delivered with recorded BOL_Gallons, THE Load_Energy_System SHALL generate exactly one Commission_Invoice addressed to the winning Supplier Company.
2. WHERE a Delivered Order is the winning Supplier Company's third or later completed win, THE Load_Energy_System SHALL calculate the Commission_Invoice amount as BOL_Gallons multiplied by the Commission_Rate.
3. WHERE a Delivered Order is among the winning Supplier Company's first two completed wins, THE Load_Energy_System SHALL mark the Order as a Waived_Win and set the Commission_Invoice amount to zero.
4. THE Load_Energy_System SHALL create each Commission_Invoice with a Payment_Status of Unpaid, including waived invoices with a zero amount.
5. IF an Order has not reached Order_Status Delivered, THEN THE Load_Energy_System SHALL NOT generate a Commission_Invoice for that Order.
6. WHEN an Admin marks a Commission_Invoice as paid, THE Load_Energy_System SHALL set the Payment_Status to Paid and persist the acting Admin and the timestamp.
7. IF a User who is not an Admin attempts to mark a Commission_Invoice as paid, THEN THE Load_Energy_System SHALL deny the action and return an authorization error.
8. WHEN an Admin requests commission due, THE Load_Energy_System SHALL return the total Unpaid Commission_Invoice amount grouped by Supplier Company.

### Requirement 13: Notifications

**User Story:** As a buyer and as a supplier, I want to be notified of key marketplace events by SMS and email, so that I can respond quickly without watching the app.

#### Acceptance Criteria

1. WHEN a Request becomes visible to a matched Supplier Company, THE Notification_Service SHALL send that Supplier a new RFQ notification.
2. WHEN a Supplier submits an Offer on a Request, THE Notification_Service SHALL send the owning Buyer a new Offer notification.
3. WHEN a Buyer accepts an Offer, THE Notification_Service SHALL send the winning Supplier an acceptance notification.
4. WHEN an Order reaches Order_Status Delivered, THE Notification_Service SHALL send the owning Buyer a delivered notification.
5. THE Notification_Service SHALL send each notification via SMS to the recipient's phone number.
6. WHERE a recipient has an email address on file, THE Notification_Service SHALL also send the notification via email.
7. IF a notification delivery attempt fails, THEN THE Notification_Service SHALL record the failure and continue processing remaining notifications.

### Requirement 14: Audit Log

**User Story:** As the marketplace operator, I want an append-only audit log of significant actions, so that I can resolve disputes about who quoted, who accepted, and what changed.

#### Acceptance Criteria

1. WHEN a Supplier submits an Offer, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting User, the Supplier Company, the Request, and the timestamp.
2. WHEN a Buyer accepts an Offer, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting User, the accepted Offer, the Order, and the timestamp.
3. WHEN a Request is cancelled or expired, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting User where any, the Request, the prior and new Request_Status, and the timestamp.
4. WHEN an Order_Status changes, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting User, the Order, the prior status, the new status, and the timestamp.
5. WHEN an Admin creates a Concierge_Order, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting Admin, the Order, and the timestamp.
6. WHEN an Admin marks a Commission_Invoice as paid, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting Admin, the Commission_Invoice, the prior and new Payment_Status, and the timestamp.
7. THE Load_Energy_System SHALL treat the Audit_Log as append-only and SHALL preserve existing entries when new entries are added.

### Requirement 15: Mobile-First Field Interface

**User Story:** As a superintendent working in the field with gloves on, I want a high-contrast, large-target interface that works on LTE, so that I can complete a request quickly in sunlight.

#### Acceptance Criteria

1. THE Load_Energy_System SHALL deliver the client as an installable progressive web application.
2. THE Load_Energy_System SHALL present the Buyer New Request flow such that gallons, Product_Type, Delivery_Method, location pin, and Delivery_Window can each be entered in a single form.
3. WHERE a device reports the user's geographic location, THE Load_Energy_System SHALL offer that location as the default Request location pin.
4. THE Load_Energy_System SHALL render interactive controls in the Buyer New Request flow with a minimum touch target size of 44 by 44 CSS pixels.

### Requirement 16: Admin Approval, Operating Location, Radius, and Geofence

**User Story:** As an admin, I want to approve suppliers and set their operating location, service radius, and the pilot geofence, so that only vetted local deliverers receive in-area requests within an area I control.

#### Acceptance Criteria

1. THE Load_Energy_System SHALL assign each newly created Supplier Company a Supplier_Approval_Status of Pending.
2. WHEN an Admin approves a Supplier Company, THE Load_Energy_System SHALL set that Company's Supplier_Approval_Status to Approved.
3. WHILE a Supplier Company's Supplier_Approval_Status is Pending, THE Load_Energy_System SHALL exclude that Company from RFQ matching.
4. WHEN an Admin sets a Supplier Company's Operating_Location, THE Load_Energy_System SHALL persist the Operating_Location for that Company.
5. WHEN an Admin sets a Supplier Company's Service_Radius, THE Load_Energy_System SHALL persist the Service_Radius for that Company.
6. IF an Admin sets a Service_Radius less than or equal to zero, THEN THE Load_Energy_System SHALL reject the change and return a validation error.
7. WHEN an Admin sets the Pilot_Geofence, THE Load_Energy_System SHALL persist the Pilot_Geofence and apply it to newly created Requests.
8. IF a User who is not an Admin attempts to approve a Supplier Company, set an Operating_Location, set a Service_Radius, or set the Pilot_Geofence, THEN THE Load_Energy_System SHALL deny the action and return an authorization error.

### Requirement 17: Admin Concierge Order Entry

**User Story:** As an admin, I want to record a deal that was arranged over the phone, so that off-app transactions still produce commission and audit records during the pilot.

#### Acceptance Criteria

1. WHEN an Admin submits a Concierge_Order with a Buyer Company, a winning Supplier Company, and BOL_Gallons greater than zero, THE Load_Energy_System SHALL create an Order with Order_Status Delivered and an associated Delivery.
2. WHERE a Concierge_Order provides a ticket number, THE Load_Energy_System SHALL store the ticket number with the Delivery.
3. WHEN a Concierge_Order reaches Order_Status Delivered with recorded BOL_Gallons, THE Load_Energy_System SHALL generate a Commission_Invoice using the same commission rules as app-originated Orders, including waived wins.
4. WHEN an Admin creates a Concierge_Order, THE Load_Energy_System SHALL append an Audit_Log entry recording the acting Admin, the Order, and the timestamp.
5. IF a User who is not an Admin attempts to create a Concierge_Order, THEN THE Load_Energy_System SHALL deny the action and return an authorization error.

## Out of Scope for v1

The following are explicitly out of scope for the pilot and are not represented by requirements: native mobile apps, fuel checkout / payment processing, title transfer, truck GPS / telemetry, auto-dispatch, ML pricing as a product, gasoline, DEF, cardlock, multi-state tax, supplier-set service radius, public listings / rack feed, offer withdrawal after submit, a ±5% gallon tolerance engine, and OCR on tickets. Supplier license verification is an offline Admin process against the ADOT supplier list and is not automated by the system.
