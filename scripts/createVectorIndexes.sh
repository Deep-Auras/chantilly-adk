#!/bin/bash

PROJECT_ID="lairry-agent"
REGION="us-central1"

echo "🚀 Creating vector indexes for Chantilly Agent..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Knowledge Base Collection - Basic Index
echo ""
echo "📚 [1/4] Creating knowledge-base basic vector index..."
gcloud firestore indexes composite create \
  --project=$PROJECT_ID \
  --collection-group=knowledge-base \
  --query-scope=COLLECTION \
  --field-config field-path=enabled,order=ASCENDING \
  --field-config field-path=embedding,vector-config='{"dimension":"768", "flat": "{}"}' \
  --async

# 2. Knowledge Base with Category Pre-filtering
echo ""
echo "🏷️  [2/4] Creating knowledge-base category-filtered index..."
gcloud firestore indexes composite create \
  --project=$PROJECT_ID \
  --collection-group=knowledge-base \
  --query-scope=COLLECTION \
  --field-config field-path=enabled,order=ASCENDING \
  --field-config field-path=category,order=ASCENDING \
  --field-config field-path=embedding,vector-config='{"dimension":"768", "flat": "{}"}' \
  --async

# 3. Task Templates Collection
echo ""
echo "📋 [3/4] Creating task-templates vector index..."
gcloud firestore indexes composite create \
  --project=$PROJECT_ID \
  --collection-group=task-templates \
  --query-scope=COLLECTION \
  --field-config field-path=enabled,order=ASCENDING \
  --field-config field-path=embedding,vector-config='{"dimension":"768", "flat": "{}"}' \
  --async

# 4. Tool Embeddings Collection
echo ""
echo "🔧 [4/4] Creating tool-embeddings vector index..."
gcloud firestore indexes composite create \
  --project=$PROJECT_ID \
  --collection-group=tool-embeddings \
  --query-scope=COLLECTION \
  --field-config field-path=embedding,vector-config='{"dimension":"768", "flat": "{}"}' \
  --async

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Index creation requests submitted!"
echo "⏳ Indexes will be ready in 10-15 minutes."
echo ""
echo "📊 Check status:"
echo "   gcloud firestore indexes composite list --project=$PROJECT_ID"
echo ""
echo "🔗 Or view in console:"
echo "   https://console.cloud.google.com/firestore/databases/-default-/indexes?project=$PROJECT_ID"
echo ""
echo "💡 Next steps:"
echo "   1. Wait for indexes to build (check status above)"
echo "   2. Run: chmod +x scripts/backfillKnowledgeBase.js"
echo "   3. Run: node scripts/backfillKnowledgeBase.js"
