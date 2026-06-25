# Z-Chat SaaS Platform

## Product Requirements Document (PRD)

Version: 1.0

Status: Architecture Phase

Product: Z-Chat

Prepared For: Engineering Team & AI Development Agents

---

# 1. PROJECT OVERVIEW

Z-Chat is currently a standalone WhatsApp CRM application.

The objective of this project is to transform Z-Chat into a fully scalable multi-tenant SaaS platform capable of serving multiple businesses simultaneously while maintaining strict tenant isolation, organization segregation, role-based permissions, subscription plans, feature management, audit logging, and enterprise-grade security.

The platform must be designed for long-term scalability and future expansion.

The final architecture must support:

* SaaS Multi-Tenant Architecture
* Multiple Organizations per Tenant
* WhatsApp Business Integration (BYOA)
* CRM
* Campaign Management
* AI Agents
* Automations
* Feature Flags
* Subscription Billing
* White Labeling
* Audit Logs
* Impersonation Support
* Marketplace Expansion

---

# 2. BUSINESS HIERARCHY

The platform consists of four levels.

## Level 1: Super Admin

Platform owner.

Responsibilities:

* Manage entire platform
* Create and manage subscription plans
* Enable and disable features
* Monitor tenants
* Suspend tenants
* Activate tenants
* View platform analytics
* View revenue analytics
* Access audit logs
* Manage support operations
* Impersonate tenant admins

Super Admin has access to all tenants.

---

## Level 2: Tenant

A paying customer.

Each tenant represents a company.

Examples:

* ABC Pvt Ltd
* XYZ Marketing Agency
* TechCorp Solutions

Each tenant owns:

* Organizations
* Users
* Contacts
* Deals
* Campaigns
* WhatsApp Integrations
* Automations
* Templates
* Analytics

A tenant must never access another tenant's data.

---

## Level 3: Organization

Organizations exist inside a tenant.

Example:

Tenant:
ABC Group

Organizations:

* ABC Real Estate
* ABC Education
* ABC Healthcare

Each organization must have:

* Separate WhatsApp Account
* Separate Contacts
* Separate Campaigns
* Separate Deals
* Separate Sales Team
* Separate Analytics

Organizations cannot access each other's data.

---

## Level 4: Users

User Types:

### Super Admin

Full platform access.

### Tenant Admin

Manages entire tenant.

### Organization Manager

Manages assigned organization.

### Sales User

Handles customer communication.

### Support User

Limited support access.

---

# 3. ROLE BASED ACCESS CONTROL (RBAC)

Implement permission-based authorization.

Do NOT hardcode permissions.

Database Tables:

* roles
* permissions
* role_permissions
* user_roles

Example Permissions:

contacts.view
contacts.create
contacts.edit
contacts.delete

campaigns.view
campaigns.create
campaigns.run

deals.view
deals.edit

users.manage

billing.manage

settings.manage

integrations.manage

ai_agents.manage

automations.manage

---

# 4. MULTI-TENANT DATA ISOLATION

Every business table must contain:

tenant_id

and where applicable:

organization_id

Example:

contacts

* id
* tenant_id
* organization_id
* name
* phone
* email

messages

* id
* tenant_id
* organization_id
* contact_id
* message

campaigns

* id
* tenant_id
* organization_id

deals

* id
* tenant_id
* organization_id

Mandatory Rule:

Every query must be filtered by:

tenant_id

Every API request must validate:

* tenant_id
* organization_id
* user permissions

No data leakage is allowed.

---

# 5. SUBSCRIPTION SYSTEM

Create SaaS subscription architecture.

Plans:

## Starter

Features:

* Inbox
* Contacts
* Basic CRM

Limits:

* 5 Users
* 1 Organization
* 1000 Contacts

---

## Growth

Features:

* Inbox
* CRM
* Campaigns
* Automations

Limits:

* 20 Users
* 5 Organizations
* 10000 Contacts

---

## Professional

Features:

* CRM
* Campaigns
* Automations
* AI Agents
* API Access

Limits:

* 100 Users
* 20 Organizations

---

## Enterprise

Features:

* Unlimited Users
* Unlimited Organizations
* White Label
* Custom Integrations
* Dedicated Support

---

# 6. FEATURE MANAGEMENT SYSTEM

Create a feature flag system.

Tables:

plans
features
plan_features

Features:

* Inbox
* CRM
* Deals
* Campaigns
* Broadcast
* AI Agents
* Automations
* Analytics
* API Access
* Webhooks
* White Label
* Marketplace

Feature Flow:

Super Admin
→ Creates Feature

Feature
→ Assigned To Plan

Plan
→ Assigned To Tenant

Tenant
→ Accesses Features

Users
→ Access Features Through Permissions

---

# 7. WHATSAPP INTEGRATION (BYOA)

Bring Your Own WhatsApp Architecture.

Every organization can connect its own:

* Meta Business Account
* WhatsApp Business API
* Phone Number

Store:

* Phone Number ID
* Business Account ID
* Access Token
* Webhook Secret

Security Requirements:

* Encrypt tokens
* Encrypt secrets
* Validate webhooks
* Rotate credentials

Each organization must have independent WhatsApp connectivity.

---

# 8. CRM MODULE

Features:

Contacts

Fields:

* Name
* Phone
* Email
* Tags
* Source
* Status

Deals

Fields:

* Deal Name
* Stage
* Value
* Owner
* Notes

Pipeline Management

Stages:

* New Lead
* Contacted
* Qualified
* Proposal
* Won
* Lost

---

# 9. CAMPAIGN MANAGEMENT

Features:

* Broadcast Campaigns
* Scheduled Campaigns
* Template Messaging
* Contact Segmentation
* Campaign Analytics

Metrics:

* Sent
* Delivered
* Read
* Replied
* Failed

---

# 10. AI AGENTS MODULE

Future-ready architecture.

Support:

* AI Chat Assistants
* Auto Replies
* Lead Qualification
* FAQ Handling
* Appointment Booking

Provider Agnostic:

* OpenAI
* Gemini
* Claude
* Local Models

Store:

* Prompt Templates
* Agent Configurations
* Knowledge Bases

---

# 11. AUTOMATION ENGINE

Workflow Builder Similar To:

* n8n
* Make.com

Capabilities:

Triggers:

* New Message
* New Contact
* Deal Won
* Campaign Response

Actions:

* Send WhatsApp Message
* Create Contact
* Update Deal
* Create Task
* Call Webhook

Architecture must support future drag-and-drop workflow builder.

---

# 12. AUDIT LOG SYSTEM

Track every action.

Audit Fields:

* User
* Action
* Resource
* Tenant
* Organization
* IP Address
* Timestamp

Events:

* Login
* Logout
* Create
* Update
* Delete
* Permission Changes
* Billing Changes
* Impersonation

---

# 13. IMPERSONATION SYSTEM

Super Admin can impersonate Tenant Admin.

Requirements:

* Reason Mandatory
* Time Limited Session
* Audit Logging
* Visual Warning Banner
* Email Notification

Blocked Actions:

* Password Change
* Billing Changes
* Workspace Deletion
* Subscription Cancellation
* Contact Export

---

# 14. TECHNICAL STACK

Frontend:

* Next.js 15
* TypeScript
* Tailwind CSS
* Zustand
* React Query

Backend:

* Node.js
* Express
* TypeScript

Database:

* PostgreSQL

Cache:

* Redis

Queues:

* BullMQ

Storage:

* S3 Compatible Storage

Authentication:

* JWT
* Refresh Tokens

---

# 15. DATABASE DESIGN REQUIREMENTS

Generate:

* Complete ER Diagram
* PostgreSQL Schema
* Relationships
* Indexing Strategy
* Foreign Keys
* Constraints

All tables must support:

* created_at
* updated_at
* created_by
* updated_by

Soft Delete:

* deleted_at

---

# 16. SECURITY REQUIREMENTS

Mandatory:

* JWT Authentication
* Refresh Tokens
* RBAC
* Tenant Isolation
* Organization Isolation
* Audit Logs
* Rate Limiting
* CSRF Protection
* XSS Protection
* Encrypted Secrets
* Password Hashing (bcrypt)

---

# 17. SCALABILITY REQUIREMENTS

Target Scale:

* 1,000+ Tenants
* 10,000+ Organizations
* 100,000+ Users
* Millions of Messages

Architecture must support:

* Horizontal Scaling
* Load Balancing
* Queue Processing
* Event Driven Design
* Microservice Migration Path

---

# 18. DELIVERABLES REQUIRED FROM AI AGENT

Generate the following:

1. Complete System Architecture
2. Database ERD
3. PostgreSQL Schema
4. Backend Folder Structure
5. Frontend Folder Structure
6. API Design
7. Authentication Flow
8. RBAC Architecture
9. Tenant Isolation Architecture
10. Feature Flag Architecture
11. Subscription Architecture
12. WhatsApp Integration Architecture
13. Audit Log Architecture
14. Impersonation Flow
15. Deployment Architecture
16. Docker Architecture
17. CI/CD Architecture
18. White Label Architecture
19. Marketplace Architecture
20. Future Microservice Migration Plan

The generated solution must be production-ready, enterprise-grade, scalable, secure, and maintainable.
