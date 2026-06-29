<template>
  <div class="permission-switcher">
    <el-tooltip :content="levelDescriptions[currentLevel]" placement="top">
      <el-dropdown trigger="click" @command="handleSwitch">
        <span class="level-badge" :class="currentLevel.toLowerCase()">
          <el-icon :size="14"><component :is="levelIcons[currentLevel]" /></el-icon>
          {{ levelLabels[currentLevel] || '只读' }}
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="level in levels"
              :key="level"
              :command="level"
              :class="{ 'is-active': level === currentLevel }"
            >
              <span class="level-option">
                <span class="level-name">
                  <el-icon :size="14"><component :is="levelIcons[level]" /></el-icon>
                  {{ levelFullLabels[level] }}
                </span>
                <span class="level-desc">{{ levelDescriptions[level] }}</span>
              </span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { ArrowDown, View, Edit, MagicStick, WarningFilled } from '@element-plus/icons-vue'
import type { Component } from 'vue'

const levels = ['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL'] as const

const levelLabels: Record<string, string> = {
  READ_ONLY: '只读',
  READ_WRITE: '读写',
  SMART: '智能审批',
  FULL: '完全权限'
}

const levelFullLabels: Record<string, string> = {
  ...levelLabels,
  FULL: '完全权限（高风险）'
}

const levelIcons: Record<string, Component> = {
  READ_ONLY: View,
  READ_WRITE: Edit,
  SMART: MagicStick,
  FULL: WarningFilled
}

const levelDescriptions: Record<string, string> = {
  READ_ONLY: '搜索和读取自动执行，写入和命令需审批',
  READ_WRITE: '文件读写自动执行，命令执行需审批',
  SMART: '文件读写自动执行，命令经 AI 判断后自动执行或审批',
  FULL: '所有操作自动执行，无需审批'
}

const props = defineProps<{
  currentLevel: string
}>()

const emit = defineEmits<{
  'update:permissionLevel': [level: string]
}>()

function handleSwitch(level: string) {
  if (level !== props.currentLevel) {
    emit('update:permissionLevel', level)
  }
}
</script>

<style scoped>
.permission-switcher {
  display: inline-flex;
  align-items: center;
}

.level-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 8px;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}

.level-badge.read_only {
  background: transparent;
  color: var(--aw-ink-muted-80);
}

.level-badge.read_write {
  background: transparent;
  color: var(--aw-primary);
}

.level-badge.smart {
  background: transparent;
  color: var(--aw-warning);
}

.level-badge.full {
  background: transparent;
  color: var(--aw-danger);
}

.level-badge:hover {
  opacity: 0.85;
}

.level-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0;
  line-height: 1.3;
}

.level-name {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
  font-size: var(--aw-text-fine);
}

.level-desc {
  font-size: 11px;
  color: var(--aw-ink-muted-48);
  font-weight: 400;
}
</style>
