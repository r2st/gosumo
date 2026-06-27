"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = exports.AnalyticsEventCategory = exports.FileUploadType = exports.AuditAction = exports.NotificationTemplateChannel = exports.EmbeddingEntityType = exports.CatalogItemType = exports.CampaignType = exports.CampaignStatus = exports.ShipmentStatus = exports.BookingStatus = exports.RefundStatus = exports.PaymentGateway = exports.PaymentMethod = exports.PaymentStatus = exports.OrderStatus = exports.RuleTrigger = exports.RuleType = exports.AiDecisionType = exports.AiDecisionOutcome = exports.TaskPriority = exports.TaskType = exports.TaskStatus = exports.TeamMemberStatus = exports.TeamMemberRole = exports.ConversationStatus = exports.MessageStatus = exports.MessageType = exports.MessageDirection = exports.ChannelType = exports.PrismaClient = void 0;
const client_1 = require("@prisma/client");
// Re-export the generated client and all its types
var client_2 = require("@prisma/client");
Object.defineProperty(exports, "PrismaClient", { enumerable: true, get: function () { return client_2.PrismaClient; } });
// Re-export all Prisma enums
var client_3 = require("@prisma/client");
Object.defineProperty(exports, "ChannelType", { enumerable: true, get: function () { return client_3.ChannelType; } });
Object.defineProperty(exports, "MessageDirection", { enumerable: true, get: function () { return client_3.MessageDirection; } });
Object.defineProperty(exports, "MessageType", { enumerable: true, get: function () { return client_3.MessageType; } });
Object.defineProperty(exports, "MessageStatus", { enumerable: true, get: function () { return client_3.MessageStatus; } });
Object.defineProperty(exports, "ConversationStatus", { enumerable: true, get: function () { return client_3.ConversationStatus; } });
Object.defineProperty(exports, "TeamMemberRole", { enumerable: true, get: function () { return client_3.TeamMemberRole; } });
Object.defineProperty(exports, "TeamMemberStatus", { enumerable: true, get: function () { return client_3.TeamMemberStatus; } });
Object.defineProperty(exports, "TaskStatus", { enumerable: true, get: function () { return client_3.TaskStatus; } });
Object.defineProperty(exports, "TaskType", { enumerable: true, get: function () { return client_3.TaskType; } });
Object.defineProperty(exports, "TaskPriority", { enumerable: true, get: function () { return client_3.TaskPriority; } });
Object.defineProperty(exports, "AiDecisionOutcome", { enumerable: true, get: function () { return client_3.AiDecisionOutcome; } });
Object.defineProperty(exports, "AiDecisionType", { enumerable: true, get: function () { return client_3.AiDecisionType; } });
Object.defineProperty(exports, "RuleType", { enumerable: true, get: function () { return client_3.RuleType; } });
Object.defineProperty(exports, "RuleTrigger", { enumerable: true, get: function () { return client_3.RuleTrigger; } });
Object.defineProperty(exports, "OrderStatus", { enumerable: true, get: function () { return client_3.OrderStatus; } });
Object.defineProperty(exports, "PaymentStatus", { enumerable: true, get: function () { return client_3.PaymentStatus; } });
Object.defineProperty(exports, "PaymentMethod", { enumerable: true, get: function () { return client_3.PaymentMethod; } });
Object.defineProperty(exports, "PaymentGateway", { enumerable: true, get: function () { return client_3.PaymentGateway; } });
Object.defineProperty(exports, "RefundStatus", { enumerable: true, get: function () { return client_3.RefundStatus; } });
Object.defineProperty(exports, "BookingStatus", { enumerable: true, get: function () { return client_3.BookingStatus; } });
Object.defineProperty(exports, "ShipmentStatus", { enumerable: true, get: function () { return client_3.ShipmentStatus; } });
Object.defineProperty(exports, "CampaignStatus", { enumerable: true, get: function () { return client_3.CampaignStatus; } });
Object.defineProperty(exports, "CampaignType", { enumerable: true, get: function () { return client_3.CampaignType; } });
Object.defineProperty(exports, "CatalogItemType", { enumerable: true, get: function () { return client_3.CatalogItemType; } });
Object.defineProperty(exports, "EmbeddingEntityType", { enumerable: true, get: function () { return client_3.EmbeddingEntityType; } });
Object.defineProperty(exports, "NotificationTemplateChannel", { enumerable: true, get: function () { return client_3.NotificationTemplateChannel; } });
Object.defineProperty(exports, "AuditAction", { enumerable: true, get: function () { return client_3.AuditAction; } });
Object.defineProperty(exports, "FileUploadType", { enumerable: true, get: function () { return client_3.FileUploadType; } });
Object.defineProperty(exports, "AnalyticsEventCategory", { enumerable: true, get: function () { return client_3.AnalyticsEventCategory; } });
exports.prisma = global.__prisma ??
    new client_1.PrismaClient({
        log: process.env['NODE_ENV'] === 'development'
            ? ['query', 'error', 'warn']
            : ['error'],
    });
if (process.env['NODE_ENV'] !== 'production') {
    global.__prisma = exports.prisma;
}
//# sourceMappingURL=index.js.map